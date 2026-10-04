// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LoanFixture} from "./helpers/loan-fixture.sol";
import {MockRouter} from "./helpers/mock-router.sol";
import {HedgeTypes} from "../src/shared/hedge-types.sol";
import {HedgeLending} from "../src/hedera/hedge-lending.sol";
import {HedgeVault} from "../src/base/hedge-vault.sol";
import {HtsToken} from "../src/hedera/hts-token.sol";
import {CcipEndpoint} from "../src/shared/ccip-endpoint.sol";
import {SafeTransferLib} from "../src/shared/safe-transfer.sol";
import {Client} from "../vendor/ccip-2.0.0/libraries/Client.sol";

contract LoanFailuresTest is LoanFixture {
    function testCallbackGasFailureCanRetrySameMessageWithoutPartialState() public {
        bytes32 id = _accept();
        _send(lending, id, HedgeTypes.Kind.Agreement);
        Client.Any2EVMMessage memory message = _message(hederaRouter.getPacket(1));
        vm.expectRevert();
        baseRouter.routeWithGas(address(vault), message, 10000);
        require(vault.getCustody(id).agreementHash == bytes32(0));
        require(vault.receivedMessages(message.messageId) == bytes32(0));
        baseRouter.routeWithGas(address(vault), message, 1000000);
        _lock(id);
        _send(vault, id, HedgeTypes.Kind.Custody);
        message = _message(baseRouter.getPacket(1));
        vm.expectRevert();
        hederaRouter.routeWithGas(address(lending), message, 10000);
        require(lending.getLoan(id).state == HedgeTypes.LoanState.Accepted && token.balanceOf(BORROWER) == 0);
        hederaRouter.routeWithGas(address(lending), message, 1000000);
        _repay(id);
        _send(lending, id, HedgeTypes.Kind.Outcome);
        message = _message(hederaRouter.getPacket(2));
        vm.expectRevert();
        baseRouter.routeWithGas(address(vault), message, 10000);
        require(lending.getLoan(id).state == HedgeTypes.LoanState.Repaid);
        require(vault.getCustody(id).outcome == HedgeTypes.Outcome.None);
        baseRouter.routeWithGas(address(vault), message, 1000000);
        vm.prank(RETURN);
        vault.claim(id);
        _assertCapital();
    }

    function testDefaultAndCancellationOutboxesSurviveFeeFailure() public {
        bytes32 cancelled = _accept();
        vm.prank(BORROWER);
        lending.cancel(cancelled);
        bytes32 defaulted = _funded();
        vm.warp(lending.getLoan(defaulted).paymentDeadline + 1);
        vm.prank(OPERATOR);
        lending.authorizeDefault(defaulted);
        hederaRouter.setFee(2);
        bytes32[2] memory ids = [cancelled, defaulted];
        for (uint256 i = 0; i < ids.length; i++) {
            bytes32 operation = lending.operationId(ids[i], HedgeTypes.Kind.Outcome);
            vm.expectRevert(abi.encodeWithSelector(CcipEndpoint.IncorrectFee.selector, uint256(2)));
            lending.sendMessage{value: 1}(operation, 1000000);
            require(lending.getOutbox(operation).payload.length != 0);
            require(lending.getOutbox(operation).submissions == 0);
            _outcome(ids[i]);
        }
        require(lending.getLoan(cancelled).state == HedgeTypes.LoanState.Cancelled);
        require(vault.getCustody(cancelled).outcome == HedgeTypes.Outcome.Return);
        require(lending.getLoan(defaulted).state == HedgeTypes.LoanState.Defaulted);
        vm.prank(RECOVERY);
        vault.claim(defaulted);
    }

    function testAgreementSendFailurePreservesReservationAndOutbox() public {
        bytes32 id = _accept();
        hederaRouter.setFailure(true);
        bytes32 operation = lending.operationId(id, HedgeTypes.Kind.Agreement);
        vm.expectRevert(abi.encodeWithSignature("Error(string)", "send failed"));
        lending.sendMessage{value: 1}(operation, 1000000);
        require(lending.getLoan(id).state == HedgeTypes.LoanState.Accepted);
        require(lending.getOutbox(operation).submissions == 0 && lending.reservedCapital(OPERATOR) == 1000000);
        hederaRouter.setFailure(false);
        _authorize(id);
        _lock(id);
        _confirm(id);
        _assertCapital();
    }

    function testCustodySendFailureKeepsLockAndCanBeRetried() public {
        bytes32 id = _accept();
        _authorize(id);
        _lock(id);
        baseRouter.setFailure(true);
        bytes32 operation = vault.operationId(id, HedgeTypes.Kind.Custody);
        vm.expectRevert(abi.encodeWithSignature("Error(string)", "send failed"));
        vault.sendMessage{value: 1}(operation, 1000000);
        require(vault.totalLocked() == 2000000 && lending.getLoan(id).state == HedgeTypes.LoanState.Accepted);
        baseRouter.setFailure(false);
        _confirm(id);
        require(token.balanceOf(BORROWER) == 1000000);
    }

    function testRepaymentPersistsWhenOutcomeSendFails() public {
        bytes32 id = _funded();
        _repay(id);
        hederaRouter.setFailure(true);
        bytes32 operation = lending.operationId(id, HedgeTypes.Kind.Outcome);
        vm.expectRevert(abi.encodeWithSignature("Error(string)", "send failed"));
        lending.sendMessage{value: 1}(operation, 1000000);
        require(lending.getLoan(id).state == HedgeTypes.LoanState.Repaid);
        require(lending.getOutbox(operation).payload.length > 0 && lending.capital(OPERATOR) == 10010000);
        vm.warp(lending.getLoan(id).paymentDeadline + 1);
        vm.expectRevert(HedgeLending.InvalidState.selector);
        vm.prank(OPERATOR);
        lending.authorizeDefault(id);
        hederaRouter.setFailure(false);
        _outcome(id);
        vm.prank(RETURN);
        vault.claim(id);
    }

    function testMissingAssociationCannotMarkFundedAndRetryWorks() public {
        HedgeTypes.Terms memory terms = _terms();
        terms.borrower = STRANGER;
        terms.fundingRecipient = STRANGER;
        bytes32 offerId = _publish(terms);
        bytes32 hash = lending.getOffer(offerId).termsHash;
        vm.prank(STRANGER);
        bytes32 id = lending.accept(offerId, hash);
        _authorize(id);
        _lock(id);
        _send(vault, id, HedgeTypes.Kind.Custody);
        uint256 index = baseRouter.count();
        MockRouter.Packet memory packet = baseRouter.getPacket(index);
        vm.expectRevert(abi.encodeWithSelector(HtsToken.HtsFailure.selector, int64(999)));
        baseRouter.deliver(index, hederaRouter);
        require(
            lending.getLoan(id).state == HedgeTypes.LoanState.Accepted && lending.reservedCapital(OPERATOR) == 1000000
        );
        require(lending.receivedMessages(packet.id) == bytes32(0));
        _associate(STRANGER);
        baseRouter.deliver(index, hederaRouter);
        require(lending.getLoan(id).state == HedgeTypes.LoanState.Funded && token.balanceOf(STRANGER) == 1000000);
        _assertCapital();
    }

    function testPayoutFailureCanCancelWithoutASecondLoan() public {
        bytes32 id = _accept();
        _authorize(id);
        _lock(id);
        hts.setFailure(999);
        _send(vault, id, HedgeTypes.Kind.Custody);
        uint256 index = baseRouter.count();
        vm.expectRevert(abi.encodeWithSelector(HtsToken.HtsFailure.selector, int64(999)));
        baseRouter.deliver(index, hederaRouter);
        vm.prank(BORROWER);
        lending.cancel(id);
        hts.setFailure(0);
        baseRouter.deliver(index, hederaRouter);
        require(token.balanceOf(BORROWER) == 0 && lending.reservedCapital(OPERATOR) == 0);
        _outcome(id);
        vm.prank(RETURN);
        vault.claim(id);
    }

    function testRepaymentFailureDoesNotClearDebt() public {
        bytes32 id = _funded();
        token.mint(BORROWER, 10000);
        vm.prank(BORROWER);
        token.approve(address(lending), 0);
        vm.expectRevert(abi.encodeWithSelector(HtsToken.HtsFailure.selector, int64(999)));
        vm.prank(BORROWER);
        lending.repay(id, 1010000);
        require(lending.getLoan(id).state == HedgeTypes.LoanState.Funded && token.balanceOf(BORROWER) == 1010000);
        require(lending.getOutbox(lending.operationId(id, HedgeTypes.Kind.Outcome)).payload.length == 0);
        vm.prank(BORROWER);
        token.approve(address(lending), 1010000);
        vm.prank(BORROWER);
        lending.repay(id, 1010000);
        _assertCapital();
    }

    function testFalseAndTaxedCollateralTransfersRollbackLock() public {
        bytes32 id = _accept();
        _authorize(id);
        bytes32 hash = lending.getLoan(id).agreementHash;
        asset.setFaults(true, false);
        vm.expectRevert(SafeTransferLib.TransferFailed.selector);
        vm.prank(OWNER);
        vault.lock(id, hash);
        asset.setFaults(false, true);
        vm.expectRevert(HedgeVault.InexactTransfer.selector);
        vm.prank(OWNER);
        vault.lock(id, hash);
        require(!vault.getCustody(id).locked && vault.totalLocked() == 0);
        require(asset.balanceOf(address(vault)) == 0 && asset.balanceOf(OWNER) == 1000000000);
        asset.setFaults(false, false);
        _lock(id);
    }

    function testCollateralClaimFailurePreservesEntitlement() public {
        bytes32 id = _funded();
        _repay(id);
        _outcome(id);
        asset.setFaults(true, false);
        vm.expectRevert(SafeTransferLib.TransferFailed.selector);
        vm.prank(RETURN);
        vault.claim(id);
        require(!vault.getCustody(id).claimed && vault.totalLocked() == 2000000);
        asset.setFaults(false, true);
        vm.expectRevert(HedgeVault.InexactTransfer.selector);
        vm.prank(RETURN);
        vault.claim(id);
        require(!vault.getCustody(id).claimed && asset.balanceOf(RETURN) == 0);
        asset.setFaults(false, false);
        vm.prank(RETURN);
        vault.claim(id);
    }

    function testInexactHtsPayoutCannotFund() public {
        bytes32 id = _accept();
        _authorize(id);
        _lock(id);
        _send(vault, id, HedgeTypes.Kind.Custody);
        token.setFaults(false, true);
        uint256 index = baseRouter.count();
        vm.expectRevert(HtsToken.InexactTransfer.selector);
        baseRouter.deliver(index, hederaRouter);
        require(lending.getLoan(id).state == HedgeTypes.LoanState.Accepted && token.balanceOf(BORROWER) == 0);
        require(lending.capital(OPERATOR) == 10000000 && lending.reservedCapital(OPERATOR) == 1000000);
    }

    function testInexactHtsDepositAndWithdrawalRollbackAccounting() public {
        token.setFaults(false, true);
        vm.expectRevert(HtsToken.InexactTransfer.selector);
        vm.prank(OPERATOR);
        lending.deposit(100);
        vm.expectRevert(HtsToken.InexactTransfer.selector);
        vm.prank(OPERATOR);
        lending.withdraw(100);
        require(lending.capital(OPERATOR) == 10000000 && token.balanceOf(address(lending)) == 10000000);
    }

    function testClaimCannotReenter() public {
        bytes32 id = _funded();
        _repay(id);
        _outcome(id);
        asset.setHook(address(vault), abi.encodeCall(vault.claim, (id)));
        vm.prank(RETURN);
        vault.claim(id);
        require(!asset.hookSucceeded() && asset.balanceOf(RETURN) == 2000000 && vault.totalLocked() == 0);
    }

    function testLockCannotReenterAnotherOperation() public {
        bytes32 id = _accept();
        _authorize(id);
        asset.setHook(address(vault), abi.encodeCall(vault.lock, (id, lending.getLoan(id).agreementHash)));
        _lock(id);
        require(!asset.hookSucceeded() && vault.totalLocked() == 2000000);
    }

    function testWrongFeeAndMissingOutboxCannotConsumeState() public {
        bytes32 id = _accept();
        bytes32 operation = lending.operationId(id, HedgeTypes.Kind.Agreement);
        vm.expectRevert(abi.encodeWithSelector(CcipEndpoint.IncorrectFee.selector, uint256(1)));
        lending.sendMessage(operation, 1000000);
        vm.expectRevert(abi.encodeWithSelector(CcipEndpoint.IncorrectFee.selector, uint256(1)));
        lending.sendMessage{value: 2}(operation, 1000000);
        vm.expectRevert(CcipEndpoint.MissingObligation.selector);
        lending.sendMessage{value: 1}(keccak256(abi.encode(id, HedgeTypes.Kind.Outcome)), 1000000);
        require(lending.getOutbox(operation).submissions == 0 && hederaRouter.count() == 0);
    }
}
