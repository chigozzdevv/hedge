// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LoanFixture} from "./helpers/loan-fixture.sol";
import {MockRouter} from "./helpers/mock-router.sol";
import {HedgeTypes} from "../src/shared/hedge-types.sol";
import {HedgeLending} from "../src/hedera/hedge-lending.sol";
import {HedgeVault} from "../src/base/hedge-vault.sol";
import {CcipEndpoint} from "../src/shared/ccip-endpoint.sol";
import {HtsToken} from "../src/hedera/hts-token.sol";
import {Client} from "../vendor/ccip-2.0.0/libraries/Client.sol";

contract LoanSecurityTest is LoanFixture {
    function testProductionRuntimeFitsDeploymentSizeLimit() public view {
        require(address(lending).code.length <= 24576, "lending exceeds EIP-170");
        require(address(vault).code.length <= 24576, "vault exceeds EIP-170");
    }

    function testExistingNativeAssociationDoesNotPreventConfiguration() public {
        vm.chainId(296);
        HedgeLending other = new HedgeLending(
            CcipEndpoint.Config(
                OPERATOR, address(hederaRouter), HEDERA_SELECTOR, BASE_SELECTOR, 84532, 0, _baseConfirmations()
            ),
            address(token),
            address(asset)
        );
        hts.simulateAutoAssociation(address(other), address(token));
        vm.prank(OPERATOR);
        other.configurePeer(address(vault));
        require(other.peer() == address(vault));
    }

    function testReceiversExposeRequiredInterfaceAndRejectZeroMessageId() public {
        require(lending.supportsInterface(0x01ffc9a7) && vault.supportsInterface(0x01ffc9a7));
        require(
            lending.supportsInterface(
                bytes4(keccak256("ccipReceive((bytes32,uint64,bytes,bytes,(address,uint256)[]))"))
            )
        );
        require(!vault.supportsInterface(0xffffffff));
        bytes32 id = _accept();
        _send(lending, id, HedgeTypes.Kind.Agreement);
        Client.Any2EVMMessage memory message = _message(hederaRouter.getPacket(1));
        message.messageId = bytes32(0);
        vm.expectRevert(CcipEndpoint.InvalidMessage.selector);
        baseRouter.route(address(vault), message);
    }

    function testBothWalletsMustAuthorizeTheirRoles() public {
        bytes32 offerId = _publish(_terms());
        bytes32 hash = lending.getOffer(offerId).termsHash;
        vm.expectRevert(CcipEndpoint.Unauthorized.selector);
        vm.prank(STRANGER);
        lending.accept(offerId, hash);
        vm.prank(BORROWER);
        bytes32 id = lending.accept(offerId, hash);
        _authorize(id);
        hash = lending.getLoan(id).agreementHash;
        vm.expectRevert(CcipEndpoint.Unauthorized.selector);
        vm.prank(BORROWER);
        vault.lock(id, hash);
        vm.expectRevert(HedgeTypes.InvalidAgreement.selector);
        vm.prank(OWNER);
        vault.lock(id, bytes32(uint256(1)));
        _lock(id);
    }

    function testAcceptanceRequiresReviewedOfferHash() public {
        bytes32 offerId = _publish(_terms());
        vm.expectRevert(HedgeLending.OfferChanged.selector);
        vm.prank(BORROWER);
        lending.accept(offerId, bytes32(uint256(1)));
        require(lending.getOffer(offerId).state == HedgeTypes.OfferState.Open);
    }

    function testOnePledgeCannotLockTwice() public {
        bytes32 id = _accept();
        _authorize(id);
        _lock(id);
        bytes32 hash = lending.getLoan(id).agreementHash;
        vm.expectRevert(HedgeVault.InvalidState.selector);
        vm.prank(OWNER);
        vault.lock(id, hash);
        require(vault.totalLocked() == 2000000);
    }

    function testOperatorCannotCancelLiveSetupOrSeizeCollateral() public {
        bytes32 id = _accept();
        vm.expectRevert(CcipEndpoint.Unauthorized.selector);
        vm.prank(OPERATOR);
        lending.cancel(id);
        _authorize(id);
        _lock(id);
        _confirm(id);
        vm.expectRevert(HedgeLending.DeadlineNotPassed.selector);
        vm.prank(OPERATOR);
        lending.authorizeDefault(id);
        vm.expectRevert(HedgeVault.InvalidState.selector);
        vm.prank(BASE_OPERATOR);
        vault.claim(id);
    }

    function testWrongPartyCannotManageCapitalRepayDefaultOrClaim() public {
        vm.expectRevert();
        vm.prank(STRANGER);
        lending.deposit(1);
        vm.expectRevert(HedgeLending.InsufficientCapital.selector);
        vm.prank(STRANGER);
        lending.withdraw(1);
        HedgeTypes.Terms memory terms = _terms();
        vm.expectRevert(HedgeLending.InsufficientCapital.selector);
        vm.prank(STRANGER);
        lending.publishOffer(terms);
        bytes32 id = _funded();
        vm.expectRevert(CcipEndpoint.Unauthorized.selector);
        vm.prank(STRANGER);
        lending.repay(id, 1010000);
        vm.expectRevert(CcipEndpoint.Unauthorized.selector);
        vm.prank(STRANGER);
        lending.authorizeDefault(id);
        _repay(id);
        _outcome(id);
        vm.expectRevert(CcipEndpoint.Unauthorized.selector);
        vm.prank(STRANGER);
        vault.claim(id);
    }

    function testBorrowerCannotClaimDefaultedPledge() public {
        bytes32 id = _funded();
        vm.warp(lending.getLoan(id).paymentDeadline + 1);
        vm.prank(OPERATOR);
        lending.authorizeDefault(id);
        _outcome(id);
        vm.expectRevert(CcipEndpoint.Unauthorized.selector);
        vm.prank(OWNER);
        vault.claim(id);
        require(!vault.getCustody(id).claimed);
    }

    function testPeerConfigurationCannotBeReplaced() public {
        vm.expectRevert(CcipEndpoint.AlreadyConfigured.selector);
        vm.prank(OPERATOR);
        lending.configurePeer(STRANGER);
        vm.expectRevert(CcipEndpoint.AlreadyConfigured.selector);
        vm.prank(BASE_OPERATOR);
        vault.configurePeer(STRANGER);
        require(lending.peer() == address(vault) && vault.peer() == address(lending));
    }

    function testUnconfiguredContractCannotAdmitCapitalOrOffers() public {
        vm.chainId(296);
        HedgeLending other = new HedgeLending(
            CcipEndpoint.Config(
                OPERATOR, address(hederaRouter), HEDERA_SELECTOR, BASE_SELECTOR, 84532, 0, _baseConfirmations()
            ),
            address(token),
            address(asset)
        );
        vm.expectRevert(CcipEndpoint.NotConfigured.selector);
        vm.prank(OPERATOR);
        other.deposit(1);
        HedgeTypes.Terms memory terms = _terms();
        vm.expectRevert(CcipEndpoint.NotConfigured.selector);
        vm.prank(OPERATOR);
        other.publishOffer(terms);
        vm.expectRevert(CcipEndpoint.Unauthorized.selector);
        vm.prank(STRANGER);
        other.configurePeer(address(vault));
    }

    function testInvalidNativeTokenOrAssociationFailureRollsBackSetup() public {
        vm.chainId(296);
        HedgeLending other = new HedgeLending(
            CcipEndpoint.Config(
                OPERATOR, address(hederaRouter), HEDERA_SELECTOR, BASE_SELECTOR, 84532, 0, _baseConfirmations()
            ),
            address(token),
            address(asset)
        );
        hts.setTokenType(1);
        vm.expectRevert(HtsToken.InvalidHtsToken.selector);
        vm.prank(OPERATOR);
        other.configurePeer(address(vault));
        require(other.peer() == address(0));
        hts.setTokenType(0);
        hts.setFailure(999);
        vm.expectRevert(HtsToken.InvalidHtsToken.selector);
        vm.prank(OPERATOR);
        other.configurePeer(address(vault));
        require(other.peer() == address(0));
        hts.setFailure(0);
        hts.setAssociationFailure(999);
        vm.expectRevert(abi.encodeWithSelector(HtsToken.HtsFailure.selector, int64(999)));
        vm.prank(OPERATOR);
        other.configurePeer(address(vault));
        require(other.peer() == address(0));
        hts.setAssociationFailure(0);
        vm.prank(OPERATOR);
        other.configurePeer(address(vault));
    }

    function testCustomFeesCannotChargeHiddenHbarOrOtherTokens() public {
        hts.setCustomFee(true);
        vm.expectRevert(HtsToken.InvalidHtsToken.selector);
        vm.prank(OPERATOR);
        lending.deposit(100);
        vm.expectRevert(HtsToken.InvalidHtsToken.selector);
        vm.prank(OPERATOR);
        lending.withdraw(100);
        hts.setCustomFee(false);
        bytes32 id = _funded();
        token.mint(BORROWER, 10000);
        hts.setCustomFee(true);
        vm.expectRevert(HtsToken.InvalidHtsToken.selector);
        vm.prank(BORROWER);
        lending.repay(id, 1010000);
        require(lending.getLoan(id).state == HedgeTypes.LoanState.Funded && token.balanceOf(BORROWER) == 1010000);
    }

    function testNewOfferCannotChangeExistingAgreement() public {
        bytes32 id = _funded();
        bytes32 hash = lending.getLoan(id).agreementHash;
        HedgeTypes.Terms memory terms = _terms();
        terms.recoveryRecipient = STRANGER;
        terms.repaymentAmount = 2000000;
        terms.policyHash = keccak256("new policy");
        _publish(terms);
        require(lending.getLoan(id).agreementHash == hash);
        require(lending.getLoan(id).agreement.terms.repaymentAmount == 1010000);
        require(vault.getCustody(id).agreement.terms.recoveryRecipient == RECOVERY);
    }

    function testWrongRouterSelectorSenderAndTokenTransfersAreRejected() public {
        bytes32 id = _accept();
        _send(lending, id, HedgeTypes.Kind.Agreement);
        Client.Any2EVMMessage memory message = _message(hederaRouter.getPacket(1));
        vm.expectRevert(CcipEndpoint.Unauthorized.selector);
        vault.ccipReceive(message);
        message.sourceChainSelector++;
        vm.expectRevert(CcipEndpoint.Unauthorized.selector);
        baseRouter.route(address(vault), message);
        message.sourceChainSelector = HEDERA_SELECTOR;
        message.sender = abi.encode(STRANGER);
        vm.expectRevert(CcipEndpoint.Unauthorized.selector);
        baseRouter.route(address(vault), message);
        message.sender = abi.encodePacked(address(lending));
        vm.expectRevert(CcipEndpoint.Unauthorized.selector);
        baseRouter.route(address(vault), message);
        message.sender = abi.encode(address(lending));
        message.destTokenAmounts = new Client.EVMTokenAmount[](1);
        vm.expectRevert(CcipEndpoint.InvalidMessage.selector);
        baseRouter.route(address(vault), message);
        require(!vault.getCustody(id).authorized);
    }

    function testWrongVersionAndBindingsFailClosed() public {
        bytes32 id = _accept();
        _send(lending, id, HedgeTypes.Kind.Agreement);
        Client.Any2EVMMessage memory original = _message(hederaRouter.getPacket(1));
        for (uint256 field = 0; field < 9; field++) {
            HedgeTypes.Message memory payload = abi.decode(original.data, (HedgeTypes.Message));
            if (field == 0) {
                payload.version++;
            } else if (field == 1) {
                payload.agreement.version++;
            } else if (field == 2) {
                payload.agreement.instanceId = bytes32(uint256(1));
            } else if (field == 3) {
                payload.agreement.hederaChainId++;
            } else if (field == 4) {
                payload.agreement.vault = STRANGER;
            } else if (field == 5) {
                payload.agreement.loanId = bytes32(uint256(1));
            } else if (field == 6) {
                payload.agreement.terms.recoveryRecipient = STRANGER;
            } else if (field == 7) {
                payload.agreementHash = bytes32(uint256(1));
            } else {
                payload.lockId = bytes32(uint256(1));
            }
            Client.Any2EVMMessage memory message = _message(hederaRouter.getPacket(1));
            message.data = abi.encode(payload);
            vm.expectRevert(HedgeTypes.InvalidAgreement.selector);
            baseRouter.route(address(vault), message);
        }
        require(!vault.getCustody(id).authorized);
    }

    function testNoPayoutForUnknownOrSubstitutedAgreement() public {
        bytes32 id = _funded();
        Client.Any2EVMMessage memory message = _message(baseRouter.getPacket(1));
        HedgeTypes.Message memory payload = abi.decode(message.data, (HedgeTypes.Message));
        payload.agreement.terms.repaymentAmount++;
        payload.agreementHash = HedgeTypes.hash(payload.agreement);
        payload.lockId = HedgeTypes.lockId(payload.agreementHash);
        message.messageId = keccak256("changed agreement");
        message.data = abi.encode(payload);
        vm.expectRevert(HedgeTypes.InvalidAgreement.selector);
        hederaRouter.route(address(lending), message);
        payload.agreement.offerId = keccak256("unknown offer");
        payload.agreement.loanId = HedgeTypes.loanId(lending.instanceId(), payload.agreement.offerId);
        payload.agreementHash = HedgeTypes.hash(payload.agreement);
        payload.lockId = HedgeTypes.lockId(payload.agreementHash);
        message.data = abi.encode(payload);
        vm.expectRevert(HedgeTypes.InvalidAgreement.selector);
        hederaRouter.route(address(lending), message);
        require(token.balanceOf(BORROWER) == 1000000);
        require(lending.getLoan(id).agreement.terms.repaymentAmount == 1010000);
    }

    function testDuplicateTransportAndFreshIdsCannotRepeatPayoutOrClaim() public {
        bytes32 id = _funded();
        baseRouter.deliver(1, hederaRouter);
        baseRouter.redeliver(1, hederaRouter, keccak256("fresh custody"));
        require(token.balanceOf(BORROWER) == 1000000 && lending.capital(OPERATOR) == 9000000);
        _repay(id);
        _outcome(id);
        vm.prank(RETURN);
        vault.claim(id);
        hederaRouter.deliver(2, baseRouter);
        hederaRouter.redeliver(2, baseRouter, keccak256("fresh outcome"));
        vm.expectRevert(HedgeVault.InvalidState.selector);
        vm.prank(RETURN);
        vault.claim(id);
        require(asset.balanceOf(RETURN) == 2000000);
    }

    function testOldAgreementCannotReviveCancelledAuthorization() public {
        bytes32 id = _accept();
        _send(lending, id, HedgeTypes.Kind.Agreement);
        vm.prank(BORROWER);
        lending.cancel(id);
        _outcome(id);
        hederaRouter.deliver(1, baseRouter);
        hederaRouter.redeliver(1, baseRouter, keccak256("late duplicate"));
        require(vault.getCustody(id).outcome == HedgeTypes.Outcome.Return);
        bytes32 hash = lending.getLoan(id).agreementHash;
        vm.expectRevert(HedgeVault.InvalidState.selector);
        vm.prank(OWNER);
        vault.lock(id, hash);
    }

    function testConflictingOutcomeAndChangedTransportIdPayloadAreRejected() public {
        bytes32 id = _funded();
        _repay(id);
        _outcome(id);
        Client.Any2EVMMessage memory message = _message(hederaRouter.getPacket(2));
        HedgeTypes.Message memory payload = abi.decode(message.data, (HedgeTypes.Message));
        payload.outcome = HedgeTypes.Outcome.Recover;
        message.data = abi.encode(payload);
        vm.expectRevert(CcipEndpoint.InvalidMessage.selector);
        baseRouter.route(address(vault), message);
        message.messageId = keccak256("conflicting outcome");
        vm.expectRevert(HedgeVault.ConflictingOutcome.selector);
        baseRouter.route(address(vault), message);
        require(vault.getCustody(id).outcome == HedgeTypes.Outcome.Return);
    }

    function testMessageKindCannotCrossTheWrongDirection() public {
        _funded();
        Client.Any2EVMMessage memory message = _message(baseRouter.getPacket(1));
        HedgeTypes.Message memory payload = abi.decode(message.data, (HedgeTypes.Message));
        payload.kind = HedgeTypes.Kind.Agreement;
        message.messageId = keccak256("wrong kind");
        message.data = abi.encode(payload);
        vm.expectRevert(CcipEndpoint.InvalidMessage.selector);
        hederaRouter.route(address(lending), message);
    }

    function testInvalidOfferEconomicsAndUnsupportedAssetAreRejected() public {
        for (uint256 field = 0; field < 6; field++) {
            HedgeTypes.Terms memory terms = _terms();
            if (field == 0) {
                terms.principal = 0;
            } else if (field == 1) {
                terms.repaymentAmount = terms.principal - 1;
            } else if (field == 2) {
                terms.fundingRecipient = STRANGER;
            } else if (field == 3) {
                terms.collateralAsset = STRANGER;
            } else if (field == 4) {
                terms.setupDeadline = terms.acceptanceDeadline;
            } else {
                terms.policyHash = bytes32(0);
            }
            vm.expectRevert(HedgeTypes.InvalidTerms.selector);
            vm.prank(OPERATOR);
            lending.publishOffer(terms);
        }
        require(lending.reservedCapital(OPERATOR) == 0);
    }
}
