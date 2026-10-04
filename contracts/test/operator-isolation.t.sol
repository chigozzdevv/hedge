// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LoanFixture} from "./helpers/loan-fixture.sol";
import {HedgeTypes} from "../src/shared/hedge-types.sol";
import {HedgeLending} from "../src/hedera/hedge-lending.sol";
import {CcipEndpoint} from "../src/shared/ccip-endpoint.sol";

contract OperatorIsolationTest is LoanFixture {
    address private constant SECOND = address(0x2222);

    function setUp() public override {
        super.setUp();
        _associate(SECOND);
        token.mint(SECOND, 7000000);
        vm.prank(SECOND);
        token.approve(address(lending), type(uint256).max);
        vm.prank(SECOND);
        lending.deposit(7000000);
    }

    function _secondLoan() private returns (bytes32 id) {
        HedgeTypes.Terms memory terms = _terms();
        terms.principal = 2000000;
        terms.repaymentAmount = 2080000;
        terms.collateralAmount = 3000000;
        terms.duration = 172800;
        terms.recoveryRecipient = SECOND;
        terms.policyHash = keccak256("second-operator-policy");
        vm.prank(SECOND);
        bytes32 offerId = lending.publishOffer(terms);
        bytes32 reviewed = lending.getOffer(offerId).termsHash;
        vm.prank(BORROWER);
        id = lending.accept(offerId, reviewed);
    }

    function _assertBoth() private view {
        require(lending.capital(OPERATOR) >= lending.reservedCapital(OPERATOR));
        require(lending.capital(SECOND) >= lending.reservedCapital(SECOND));
        require(token.balanceOf(address(lending)) == lending.capital(OPERATOR) + lending.capital(SECOND));
        require(asset.balanceOf(address(vault)) >= vault.totalLocked());
    }

    function testEachOperatorWithdrawsOnlyItsOwnFreeCapital() public {
        vm.expectRevert(HedgeLending.InsufficientCapital.selector);
        vm.prank(SECOND);
        lending.withdraw(7000001);
        vm.prank(SECOND);
        lending.withdraw(7000000);
        require(lending.capital(SECOND) == 0 && lending.capital(OPERATOR) == 10000000);
        require(token.balanceOf(SECOND) == 7000000);
        _assertBoth();
    }

    function testOffersAndReviewedHashesBindTheirIssuingOperator() public {
        HedgeTypes.Terms memory terms = _terms();
        bytes32 first = _publish(terms);
        vm.prank(SECOND);
        bytes32 second = lending.publishOffer(terms);
        require(first != second);
        require(lending.getOffer(first).operator == OPERATOR && lending.getOffer(second).operator == SECOND);
        require(lending.getOffer(first).termsHash != lending.getOffer(second).termsHash);
        require(lending.reservedCapital(OPERATOR) == 1000000 && lending.reservedCapital(SECOND) == 1000000);
        bytes32 wrongHash = lending.getOffer(first).termsHash;
        vm.expectRevert(HedgeLending.OfferChanged.selector);
        vm.prank(BORROWER);
        lending.accept(second, wrongHash);
        _assertBoth();
    }

    function testOtherOperatorCannotWithdrawAnOfferIncludingDeploymentSigner() public {
        vm.prank(SECOND);
        bytes32 offerId = lending.publishOffer(_terms());
        vm.expectRevert(CcipEndpoint.Unauthorized.selector);
        vm.prank(OPERATOR);
        lending.withdrawOffer(offerId);
        vm.prank(SECOND);
        lending.withdrawOffer(offerId);
        require(lending.reservedCapital(SECOND) == 0 && lending.capital(OPERATOR) == 10000000);
        _assertBoth();
    }

    function testOperatorCannotBorrowCapitalFromAnotherOperatorsBalance() public {
        HedgeTypes.Terms memory terms = _terms();
        terms.principal = 8000000;
        terms.repaymentAmount = 8080000;
        vm.expectRevert(HedgeLending.InsufficientCapital.selector);
        vm.prank(SECOND);
        lending.publishOffer(terms);
        require(lending.offerNonce(SECOND) == 0 && lending.reservedCapital(SECOND) == 0);
        _assertBoth();
    }

    function testRepaymentAndDifferentRulesStayWithTheIssuingOperator() public {
        bytes32 first = _funded();
        bytes32 second = _secondLoan();
        _authorize(second);
        _lock(second);
        _confirm(second);
        HedgeLending.Loan memory loan = lending.getLoan(second);
        require(loan.agreement.operator == SECOND && loan.agreement.terms.duration == 172800);
        require(lending.capital(OPERATOR) == 9000000 && lending.capital(SECOND) == 5000000);
        token.mint(BORROWER, 90000);
        vm.prank(BORROWER);
        lending.repay(second, 2080000);
        require(lending.capital(OPERATOR) == 9000000 && lending.capital(SECOND) == 7080000);
        require(lending.getLoan(first).state == HedgeTypes.LoanState.Funded);
        _outcome(second);
        vm.prank(RETURN);
        vault.claim(second);
        require(vault.getCustody(first).locked && !vault.getCustody(first).claimed);
        _assertBoth();
    }

    function testCancellationAndExpiryReleaseOnlyTheirOperatorsReservation() public {
        bytes32 first = _accept();
        bytes32 second = _secondLoan();
        vm.prank(BORROWER);
        lending.cancel(second);
        require(lending.reservedCapital(OPERATOR) == 1000000 && lending.reservedCapital(SECOND) == 0);
        require(lending.getLoan(first).state == HedgeTypes.LoanState.Accepted);
        vm.prank(SECOND);
        bytes32 unused = lending.publishOffer(_terms());
        vm.warp(block.timestamp + 601);
        lending.expireOffer(unused);
        require(lending.reservedCapital(OPERATOR) == 1000000 && lending.reservedCapital(SECOND) == 0);
        _assertBoth();
    }

    function testDefaultAndRecoveryCannotBeAuthorizedByAnotherOperator() public {
        bytes32 second = _secondLoan();
        _authorize(second);
        _lock(second);
        _confirm(second);
        vm.warp(lending.getLoan(second).paymentDeadline + 1);
        vm.expectRevert(CcipEndpoint.Unauthorized.selector);
        vm.prank(OPERATOR);
        lending.authorizeDefault(second);
        vm.prank(SECOND);
        lending.authorizeDefault(second);
        _outcome(second);
        vm.expectRevert(CcipEndpoint.Unauthorized.selector);
        vm.prank(OPERATOR);
        vault.claim(second);
        vm.prank(SECOND);
        vault.claim(second);
        require(asset.balanceOf(SECOND) == 3000000 && lending.capital(OPERATOR) == 10000000);
        _assertBoth();
    }

    function testPayoutFailureRetryPreservesBothOperatorsBalances() public {
        bytes32 second = _secondLoan();
        _authorize(second);
        _lock(second);
        _send(vault, second, HedgeTypes.Kind.Custody);
        uint256 packet = baseRouter.count();
        hts.setFailure(7);
        vm.expectRevert();
        baseRouter.deliverWithPolicy(packet, hederaRouter);
        require(lending.getLoan(second).state == HedgeTypes.LoanState.Accepted);
        require(lending.capital(SECOND) == 7000000 && lending.reservedCapital(SECOND) == 2000000);
        require(lending.capital(OPERATOR) == 10000000 && lending.reservedCapital(OPERATOR) == 0);
        _assertBoth();
        hts.setFailure(0);
        baseRouter.deliverWithPolicy(baseRouter.count(), hederaRouter);
        require(lending.capital(SECOND) == 5000000 && lending.reservedCapital(SECOND) == 0);
        require(token.balanceOf(BORROWER) == 2000000);
        _assertBoth();
    }

    function testFuzzOperatorSequences(bytes calldata actions) public {
        bytes32[2] memory ids;
        ids[0] = _accept();
        ids[1] = _secondLoan();
        token.mint(BORROWER, 100000);
        uint256 length = actions.length > 64 ? 64 : actions.length;
        for (uint256 i; i < length; i++) {
            uint256 seed = uint8(actions[i]);
            uint256 index = seed % 2;
            bytes32 id = ids[index];
            uint256 action = seed / 2 % 9;
            address lender = index == 0 ? OPERATOR : SECOND;
            if (action == 0) {
                _authorize(id);
            } else if (action == 1) {
                _attempt(OWNER, address(vault), abi.encodeCall(vault.lock, (id, lending.getLoan(id).agreementHash)));
            } else if (action == 2 && vault.getCustody(id).locked) {
                _send(vault, id, HedgeTypes.Kind.Custody);
                try baseRouter.deliver(baseRouter.count(), hederaRouter) {} catch {}
            } else if (action == 3) {
                _attempt(BORROWER, address(lending), abi.encodeCall(lending.cancel, (id)));
            } else if (action == 4) {
                _attempt(
                    BORROWER,
                    address(lending),
                    abi.encodeCall(lending.repay, (id, lending.getLoan(id).agreement.terms.repaymentAmount))
                );
            } else if (action == 5) {
                _attempt(lender, address(lending), abi.encodeCall(lending.authorizeDefault, (id)));
            } else if (action == 6) {
                _attempt(lender, address(lending), abi.encodeCall(lending.withdraw, (seed * 10000)));
            } else if (action == 7) {
                _attempt(
                    index == 0 ? SECOND : OPERATOR, address(lending), abi.encodeCall(lending.authorizeDefault, (id))
                );
            } else if (action == 8) {
                vm.warp(block.timestamp + 20000);
            }
            _assertBoth();
            for (uint256 j; j < 2; j++) {
                uint256 initial = j == 0 ? 10000000 : 7000000;
                address owner = j == 0 ? OPERATOR : SECOND;
                HedgeLending.Loan memory loan = lending.getLoan(ids[j]);
                uint256 used = loan.fundedAt == 0 ? 0 : loan.agreement.terms.principal;
                uint256 repaid = loan.state == HedgeTypes.LoanState.Repaid ? loan.agreement.terms.repaymentAmount : 0;
                uint256 withdrawn = token.balanceOf(owner) - (j == 0 ? 990000000 : 0);
                require(lending.capital(owner) == initial - used + repaid - withdrawn);
                require(
                    lending.reservedCapital(owner)
                        == (loan.state == HedgeTypes.LoanState.Accepted ? loan.agreement.terms.principal : 0)
                );
            }
        }
    }

    function _attempt(address sender, address target, bytes memory data) private {
        vm.prank(sender);
        (bool success,) = target.call(data);
        if (!success) {
            return;
        }
    }
}
