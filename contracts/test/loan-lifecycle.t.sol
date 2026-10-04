// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LoanFixture} from "./helpers/loan-fixture.sol";
import {HedgeTypes} from "../src/shared/hedge-types.sol";
import {HedgeLending} from "../src/hedera/hedge-lending.sol";
import {HedgeVault} from "../src/base/hedge-vault.sol";
import {CcipEndpoint} from "../src/shared/ccip-endpoint.sol";

contract LoanLifecycleTest is LoanFixture {
    function testAcceptanceAtDeadlineAndExpiryOnlyAfterwards() public {
        bytes32 offerId = _publish(_terms());
        HedgeLending.Offer memory offer = lending.getOffer(offerId);
        vm.warp(offer.terms.acceptanceDeadline);
        vm.expectRevert(HedgeLending.DeadlineNotPassed.selector);
        lending.expireOffer(offerId);
        vm.prank(BORROWER);
        bytes32 id = lending.accept(offerId, offer.termsHash);
        require(lending.getLoan(id).state == HedgeTypes.LoanState.Accepted);
    }

    function testCompleteRepaymentAndReturn() public {
        bytes32 id = _funded();
        HedgeLending.Loan memory loan = lending.getLoan(id);
        require(loan.state == HedgeTypes.LoanState.Funded);
        require(loan.fundedAt == block.timestamp && loan.paymentDeadline == block.timestamp + 86430);
        require(token.balanceOf(BORROWER) == 1000000 && lending.reservedCapital(OPERATOR) == 0);
        require(lending.capital(OPERATOR) == 9000000 && vault.totalLocked() == 2000000);
        _repay(id);
        require(lending.getLoan(id).state == HedgeTypes.LoanState.Repaid);
        require(lending.capital(OPERATOR) == 10010000);
        require(vault.getCustody(id).outcome == HedgeTypes.Outcome.None, "return needs a message");
        _outcome(id);
        vm.prank(OWNER);
        vault.claim(id);
        require(asset.balanceOf(RETURN) == 2000000 && asset.balanceOf(RECOVERY) == 0);
        require(vault.getCustody(id).claimed && vault.totalLocked() == 0);
        _assertCapital();
    }

    function testDefaultAndRecoveryAfterDeadline() public {
        bytes32 id = _funded();
        vm.warp(lending.getLoan(id).paymentDeadline + 1);
        vm.prank(OPERATOR);
        lending.authorizeDefault(id);
        require(lending.getLoan(id).state == HedgeTypes.LoanState.Defaulted);
        _outcome(id);
        vm.prank(RECOVERY);
        vault.claim(id);
        require(asset.balanceOf(RECOVERY) == 2000000 && asset.balanceOf(RETURN) == 0);
        require(lending.capital(OPERATOR) == 9000000 && vault.totalLocked() == 0);
        _assertCapital();
    }

    function testCancelBeforeAgreementIsDelivered() public {
        bytes32 id = _accept();
        vm.prank(BORROWER);
        lending.cancel(id);
        _outcome(id);
        _authorize(id);
        bytes32 hash = lending.getLoan(id).agreementHash;
        vm.expectRevert(HedgeVault.InvalidState.selector);
        vm.prank(OWNER);
        vault.lock(id, hash);
        require(lending.capital(OPERATOR) == 10000000 && lending.reservedCapital(OPERATOR) == 0);
        require(asset.balanceOf(address(vault)) == 0 && token.balanceOf(BORROWER) == 0);
    }

    function testCancelAfterAgreementBeforeLock() public {
        bytes32 id = _accept();
        _authorize(id);
        vm.prank(BORROWER);
        lending.cancel(id);
        _outcome(id);
        bytes32 hash = lending.getLoan(id).agreementHash;
        vm.expectRevert(HedgeVault.InvalidState.selector);
        vm.prank(OWNER);
        vault.lock(id, hash);
    }

    function testCancelAfterLockBeforeConfirmation() public {
        bytes32 id = _accept();
        _authorize(id);
        _lock(id);
        vm.prank(BORROWER);
        lending.cancel(id);
        _confirm(id);
        require(token.balanceOf(BORROWER) == 0 && lending.getLoan(id).state == HedgeTypes.LoanState.Cancelled);
        _outcome(id);
        vm.prank(OWNER);
        vault.claim(id);
        require(asset.balanceOf(RETURN) == 2000000);
        _assertCapital();
    }

    function testLockRacingCancellationReturnsWithoutFunding() public {
        bytes32 id = _accept();
        _authorize(id);
        vm.prank(BORROWER);
        lending.cancel(id);
        // Base has not learned the canonical cancellation yet.
        _lock(id);
        _confirm(id);
        _outcome(id);
        vm.prank(RETURN);
        vault.claim(id);
        require(token.balanceOf(BORROWER) == 0 && asset.balanceOf(RETURN) == 2000000);
    }

    function testFundingWinsCancellationRace() public {
        bytes32 id = _funded();
        vm.expectRevert(HedgeLending.InvalidState.selector);
        vm.prank(BORROWER);
        lending.cancel(id);
        require(lending.getLoan(id).state == HedgeTypes.LoanState.Funded);
    }

    function testLateCustodyConfirmationCancelsAndReturns() public {
        bytes32 id = _accept();
        _authorize(id);
        _lock(id);
        vm.warp(lending.getLoan(id).agreement.terms.setupDeadline + 1);
        _confirm(id);
        require(lending.getLoan(id).state == HedgeTypes.LoanState.Cancelled && token.balanceOf(BORROWER) == 0);
        _outcome(id);
        vm.prank(OWNER);
        vault.claim(id);
        _assertCapital();
    }

    function testAnyoneCanCancelExpiredSetup() public {
        bytes32 id = _accept();
        vm.warp(lending.getLoan(id).agreement.terms.setupDeadline + 1);
        vm.prank(STRANGER);
        lending.cancel(id);
        require(lending.reservedCapital(OPERATOR) == 0);
    }

    function testNoBaseTimeoutSeizureOrRefund() public {
        bytes32 id = _funded();
        vm.warp(lending.getLoan(id).paymentDeadline + 1000000);
        vm.expectRevert(HedgeVault.InvalidState.selector);
        vm.prank(OWNER);
        vault.claim(id);
        vm.expectRevert(HedgeVault.InvalidState.selector);
        vm.prank(RECOVERY);
        vault.claim(id);
        require(vault.totalLocked() == 2000000);
    }

    function testRepaymentAllowedAtDeadlineAndDefaultOnlyAfterwards() public {
        bytes32 id = _funded();
        vm.warp(lending.getLoan(id).paymentDeadline);
        vm.expectRevert(HedgeLending.DeadlineNotPassed.selector);
        vm.prank(OPERATOR);
        lending.authorizeDefault(id);
        _repay(id);
        vm.warp(block.timestamp + 1);
        vm.expectRevert(HedgeLending.InvalidState.selector);
        vm.prank(OPERATOR);
        lending.authorizeDefault(id);
    }

    function testGracePeriodIsPartOfEnforcedDeadline() public {
        bytes32 id = _funded();
        vm.warp(lending.getLoan(id).fundedAt + 86400);
        vm.expectRevert(HedgeLending.DeadlineNotPassed.selector);
        vm.prank(OPERATOR);
        lending.authorizeDefault(id);
        _repay(id);
    }

    function testLateRepaymentCannotTakeTokensOrReverseDefault() public {
        bytes32 id = _funded();
        token.mint(BORROWER, 10000);
        uint256 before = token.balanceOf(BORROWER);
        vm.warp(lending.getLoan(id).paymentDeadline + 1);
        vm.expectRevert(HedgeLending.DeadlinePassed.selector);
        vm.prank(BORROWER);
        lending.repay(id, 1010000);
        vm.prank(OPERATOR);
        lending.authorizeDefault(id);
        vm.expectRevert(HedgeLending.InvalidState.selector);
        vm.prank(BORROWER);
        lending.repay(id, 1010000);
        require(token.balanceOf(BORROWER) == before);
    }

    function testPartialAndExcessRepaymentTakeNoTokens() public {
        bytes32 id = _funded();
        for (uint256 amount = 1009999; amount <= 1010001; amount += 2) {
            vm.expectRevert(HedgeLending.IncorrectRepayment.selector);
            vm.prank(BORROWER);
            lending.repay(id, amount);
        }
        require(token.balanceOf(BORROWER) == 1000000 && lending.getLoan(id).state == HedgeTypes.LoanState.Funded);
    }

    function testClaimsAndRepaymentCannotRepeat() public {
        bytes32 id = _funded();
        _repay(id);
        vm.expectRevert(HedgeLending.InvalidState.selector);
        vm.prank(BORROWER);
        lending.repay(id, 1010000);
        _outcome(id);
        vm.prank(OWNER);
        vault.claim(id);
        vm.expectRevert(HedgeVault.InvalidState.selector);
        vm.prank(OWNER);
        vault.claim(id);
        require(asset.balanceOf(RETURN) == 2000000);
    }

    function testOfferFundsAreReservedAtPublicationAndAcceptance() public {
        bytes32 offerId = _publish(_terms());
        require(lending.freeCapital(OPERATOR) == 9000000 && lending.reservedCapital(OPERATOR) == 1000000);
        vm.expectRevert(HedgeLending.InsufficientCapital.selector);
        vm.prank(OPERATOR);
        lending.withdraw(9000001);
        bytes32 hash = lending.getOffer(offerId).termsHash;
        vm.prank(BORROWER);
        bytes32 id = lending.accept(offerId, hash);
        require(lending.reservedCapital(OPERATOR) == 1000000 && token.balanceOf(BORROWER) == 0);
        vm.expectRevert(HedgeLending.InvalidState.selector);
        vm.prank(OPERATOR);
        lending.withdrawOffer(offerId);
        vm.prank(BORROWER);
        lending.cancel(id);
        vm.prank(OPERATOR);
        lending.withdraw(10000000);
        require(lending.capital(OPERATOR) == 0);
    }

    function testOfferCannotOvercommitOrBeAcceptedTwice() public {
        HedgeTypes.Terms memory terms = _terms();
        terms.principal = 10000000;
        terms.repaymentAmount = 10010000;
        bytes32 offerId = _publish(terms);
        vm.expectRevert(HedgeLending.InsufficientCapital.selector);
        vm.prank(OPERATOR);
        lending.publishOffer(_terms());
        bytes32 hash = lending.getOffer(offerId).termsHash;
        vm.prank(BORROWER);
        lending.accept(offerId, hash);
        vm.expectRevert(HedgeLending.InvalidState.selector);
        vm.prank(BORROWER);
        lending.accept(offerId, hash);
    }

    function testOfferWithdrawAndExpiryFreeOnlyTheirReservation() public {
        bytes32 first = _publish(_terms());
        bytes32 second = _publish(_terms());
        vm.prank(OPERATOR);
        lending.withdrawOffer(first);
        require(lending.reservedCapital(OPERATOR) == 1000000);
        bytes32 firstHash = lending.getOffer(first).termsHash;
        bytes32 secondHash = lending.getOffer(second).termsHash;
        vm.expectRevert(HedgeLending.InvalidState.selector);
        vm.prank(BORROWER);
        lending.accept(first, firstHash);
        vm.warp(lending.getOffer(second).terms.acceptanceDeadline + 1);
        vm.expectRevert(HedgeLending.DeadlinePassed.selector);
        vm.prank(BORROWER);
        lending.accept(second, secondHash);
        lending.expireOffer(second);
        require(lending.reservedCapital(OPERATOR) == 0);
    }

    function testOneSecondPastSetupCannotLock() public {
        bytes32 id = _accept();
        _authorize(id);
        vm.warp(lending.getLoan(id).agreement.terms.setupDeadline + 1);
        bytes32 hash = lending.getLoan(id).agreementHash;
        vm.expectRevert(HedgeVault.DeadlinePassed.selector);
        vm.prank(OWNER);
        vault.lock(id, hash);
        require(vault.totalLocked() == 0);
    }

    function testLockAndFundingAtSetupDeadlineAreAllowed() public {
        bytes32 id = _accept();
        _authorize(id);
        vm.warp(lending.getLoan(id).agreement.terms.setupDeadline);
        _lock(id);
        _confirm(id);
        require(lending.getLoan(id).state == HedgeTypes.LoanState.Funded);
    }

    function testSeparateLoansCannotShareAClaim() public {
        bytes32 first = _funded();
        bytes32 second = _funded();
        require(vault.totalLocked() == 4000000);
        _repay(first);
        _outcome(first);
        vm.prank(OWNER);
        vault.claim(first);
        require(vault.totalLocked() == 2000000 && !vault.getCustody(second).claimed);
        vm.expectRevert(HedgeVault.InvalidState.selector);
        vm.prank(OWNER);
        vault.claim(second);
        _assertCapital();
    }

    function testDonationsDoNotCreateCapitalOrCollateralEntitlement() public {
        token.mint(address(lending), 500);
        asset.mint(address(vault), 600);
        require(lending.capital(OPERATOR) == 10000000 && vault.totalLocked() == 0);
        bytes32 id = _funded();
        _repay(id);
        _outcome(id);
        vm.prank(OWNER);
        vault.claim(id);
        require(asset.balanceOf(address(vault)) == 600 && asset.balanceOf(RETURN) == 2000000);
        _assertCapital();
    }
}
