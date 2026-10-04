// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LoanFixture} from "./helpers/loan-fixture.sol";
import {HedgeTypes} from "../src/shared/hedge-types.sol";
import {HedgeLending} from "../src/hedera/hedge-lending.sol";
import {HedgeVault} from "../src/base/hedge-vault.sol";
import {CcipEndpoint} from "../src/shared/ccip-endpoint.sol";

contract CollateralRepaymentTest is LoanFixture {
    mapping(bytes32 => bytes32) private hashes;

    function _eligible(uint256 amount) private returns (bytes32 id) {
        HedgeTypes.Terms memory terms = _terms();
        terms.collateralRepaymentAmount = amount;
        id = _acceptTerms(terms);
        _authorize(id);
        _lock(id);
        _confirm(id);
        hashes[id] = lending.getLoan(id).agreementHash;
    }

    function _request(bytes32 id) private {
        vm.prank(BORROWER);
        lending.repayWithCollateral(id, hashes[id]);
    }

    function _receipt(bytes32 id) private {
        _send(vault, id, HedgeTypes.Kind.Settlement);
        baseRouter.deliverWithPolicy(baseRouter.count(), hederaRouter);
    }

    function testExactSplitAndCanonicalConfirmation() public {
        bytes32 id = _eligible(1010000);
        _request(id);
        require(lending.getLoan(id).state == HedgeTypes.LoanState.Settling);
        require(asset.balanceOf(RECOVERY) == 0 && asset.balanceOf(RETURN) == 0);
        vm.expectRevert(HedgeVault.InvalidState.selector);
        vault.settle(id);
        _outcome(id);
        vm.prank(STRANGER);
        vault.settle(id);
        require(asset.balanceOf(RECOVERY) == 1010000 && asset.balanceOf(RETURN) == 990000);
        require(vault.getCustody(id).claimed && vault.totalLocked() == 0);
        require(lending.getLoan(id).state == HedgeTypes.LoanState.Settling, "submission is not settlement");
        _receipt(id);
        require(lending.getLoan(id).state == HedgeTypes.LoanState.Repaid);
        require(lending.capital(OPERATOR) == 9000000, "no unbacked Hedera capital");
        require(token.balanceOf(BORROWER) == 1000000, "no Hedera wallet debit");
        _assertCapital();
    }

    function testDisabledAndExcessAmountRejected() public {
        bytes32 id = _funded();
        vm.expectRevert(HedgeLending.InvalidState.selector);
        _request(id);
        HedgeTypes.Terms memory terms = _terms();
        terms.collateralRepaymentAmount = terms.collateralAmount + 1;
        vm.expectRevert(HedgeTypes.InvalidTerms.selector);
        _publish(terms);
    }

    function testOnlyBorrowerAndReviewedAgreementBeforeDeadline() public {
        bytes32 id = _eligible(1010000);
        bytes32 hash = lending.getLoan(id).agreementHash;
        vm.prank(STRANGER);
        vm.expectRevert(CcipEndpoint.Unauthorized.selector);
        lending.repayWithCollateral(id, hash);
        vm.prank(BORROWER);
        vm.expectRevert(HedgeTypes.InvalidAgreement.selector);
        lending.repayWithCollateral(id, bytes32(uint256(1)));
        vm.warp(lending.getLoan(id).paymentDeadline + 1);
        vm.expectRevert(HedgeLending.DeadlinePassed.selector);
        _request(id);
    }

    function testPendingSettlementExcludesRepaymentDefaultAndClaim() public {
        bytes32 id = _eligible(1010000);
        _request(id);
        vm.prank(BORROWER);
        vm.expectRevert(HedgeLending.InvalidState.selector);
        lending.repay(id, 1010000);
        vm.warp(lending.getLoan(id).paymentDeadline + 1);
        vm.prank(OPERATOR);
        vm.expectRevert(HedgeLending.InvalidState.selector);
        lending.authorizeDefault(id);
        _outcome(id);
        vm.expectRevert(HedgeVault.InvalidState.selector);
        vault.claim(id);
        vault.settle(id);
        _receipt(id);
        require(lending.getLoan(id).state == HedgeTypes.LoanState.Repaid);
    }

    function testWalletRepaymentWinsAndCannotBeChanged() public {
        bytes32 id = _eligible(1010000);
        _repay(id);
        vm.expectRevert(HedgeLending.InvalidState.selector);
        _request(id);
        _outcome(id);
        vm.expectRevert(HedgeVault.InvalidState.selector);
        vault.settle(id);
        vm.prank(RETURN);
        vault.claim(id);
        require(asset.balanceOf(RETURN) == 2000000 && asset.balanceOf(RECOVERY) == 0);
    }

    function testTransferFailureRollsBackAndCanRetry() public {
        bytes32 id = _eligible(1010000);
        _request(id);
        _outcome(id);
        asset.setFaults(true, false);
        vm.expectRevert();
        vault.settle(id);
        require(!vault.getCustody(id).claimed && vault.totalLocked() == 2000000);
        require(vault.getOutbox(vault.operationId(id, HedgeTypes.Kind.Settlement)).payload.length == 0);
        asset.setFaults(false, true);
        vm.expectRevert(HedgeVault.InexactTransfer.selector);
        vault.settle(id);
        require(asset.balanceOf(RECOVERY) == 0 && asset.balanceOf(RETURN) == 0);
        asset.setFaults(false, false);
        vault.settle(id);
        _receipt(id);
        _assertCapital();
    }

    function testSendFailureAndDuplicateReceiptDoNotPayTwice() public {
        bytes32 id = _eligible(1010000);
        _request(id);
        _outcome(id);
        vault.settle(id);
        baseRouter.setFailure(true);
        bytes32 operation = vault.operationId(id, HedgeTypes.Kind.Settlement);
        uint256 fee = vault.quoteMessage(operation, 1000000);
        vm.expectRevert();
        vault.sendMessage{value: fee}(operation, 1000000);
        require(lending.getLoan(id).state == HedgeTypes.LoanState.Settling);
        baseRouter.setFailure(false);
        _receipt(id);
        baseRouter.redeliver(baseRouter.count(), hederaRouter, keccak256("duplicate settlement"));
        hederaRouter.redeliver(hederaRouter.count(), baseRouter, keccak256("duplicate authorization"));
        vm.expectRevert(HedgeVault.InvalidState.selector);
        vault.settle(id);
        require(asset.balanceOf(RECOVERY) == 1010000 && asset.balanceOf(RETURN) == 990000);
        _assertCapital();
    }

    function testReentrancyCannotDuplicateSplit() public {
        bytes32 id = _eligible(1010000);
        _request(id);
        _outcome(id);
        asset.setHook(address(vault), abi.encodeCall(vault.settle, (id)));
        vault.settle(id);
        require(!asset.hookSucceeded());
        require(asset.balanceOf(RECOVERY) == 1010000 && asset.balanceOf(RETURN) == 990000);
    }

    function testFuzzSplitConservation(uint64 seed) public {
        uint256 amount = uint256(seed) % 2000000 + 1;
        bytes32 id = _eligible(amount);
        _request(id);
        _outcome(id);
        vault.settle(id);
        _receipt(id);
        require(asset.balanceOf(RECOVERY) == amount);
        require(asset.balanceOf(RETURN) == 2000000 - amount);
        require(vault.totalLocked() == 0 && asset.balanceOf(address(vault)) == 0);
        _assertCapital();
    }

    function testFuzzConcurrentSettlementSequences(bytes calldata actions) public {
        bytes32[2] memory ids = [_eligible(1010000), _eligible(1010000)];
        token.mint(BORROWER, 20000);
        uint256 length = actions.length > 64 ? 64 : actions.length;
        for (uint256 i; i < length; i++) {
            uint256 seed = uint8(actions[i]);
            bytes32 id = ids[seed % 2];
            uint256 action = seed / 2 % 8;
            if (action == 0) {
                _attempt(BORROWER, address(lending), abi.encodeCall(lending.repayWithCollateral, (id, hashes[id])));
            }
            if (action == 1) {
                _attempt(BORROWER, address(lending), abi.encodeCall(lending.repay, (id, 1010000)));
            }
            if (action == 2) {
                _attempt(OPERATOR, address(lending), abi.encodeCall(lending.authorizeDefault, (id)));
            }
            if (action == 3) {
                vm.warp(block.timestamp + 20000);
            }
            if (action == 4 && lending.getOutbox(lending.operationId(id, HedgeTypes.Kind.Outcome)).payload.length != 0)
            {
                _outcome(id);
            }
            if (action == 5) {
                _attempt(STRANGER, address(vault), abi.encodeCall(vault.settle, (id)));
            }
            if (action == 6 && vault.getOutbox(vault.operationId(id, HedgeTypes.Kind.Settlement)).payload.length != 0) {
                _receipt(id);
            }
            if (action == 7) {
                address claimant = vault.getCustody(id).outcome == HedgeTypes.Outcome.Recover ? RECOVERY : RETURN;
                _attempt(claimant, address(vault), abi.encodeCall(vault.claim, (id)));
            }
            uint256 cashRepaid;
            uint256 returnedAmount;
            uint256 recoveredAmount;
            uint256 locked;
            for (uint256 j; j < ids.length; j++) {
                HedgeLending.Loan memory loan = lending.getLoan(ids[j]);
                HedgeVault.Custody memory entry = vault.getCustody(ids[j]);
                if (loan.state == HedgeTypes.LoanState.Repaid && entry.outcome != HedgeTypes.Outcome.Settle) {
                    cashRepaid += 1010000;
                }
                if (!entry.claimed) {
                    locked += 2000000;
                }
                if (entry.outcome == HedgeTypes.Outcome.Settle) {
                    require(loan.state == HedgeTypes.LoanState.Settling || loan.state == HedgeTypes.LoanState.Repaid);
                    if (loan.state == HedgeTypes.LoanState.Repaid) {
                        require(entry.claimed);
                    }
                }
                if (entry.claimed) {
                    if (entry.outcome == HedgeTypes.Outcome.Settle) {
                        returnedAmount += 990000;
                        recoveredAmount += 1010000;
                    } else if (entry.outcome == HedgeTypes.Outcome.Recover) {
                        recoveredAmount += 2000000;
                    } else {
                        returnedAmount += 2000000;
                    }
                }
            }
            require(lending.capital(OPERATOR) == 8000000 + cashRepaid);
            require(token.balanceOf(BORROWER) == 2020000 - cashRepaid);
            require(vault.totalLocked() == locked && asset.balanceOf(address(vault)) == locked);
            require(asset.balanceOf(RETURN) == returnedAmount && asset.balanceOf(RECOVERY) == recoveredAmount);
            _assertCapital();
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
