// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LoanFixture} from "./helpers/loan-fixture.sol";
import {LoanLifecycleTest} from "./loan-lifecycle.t.sol";
import {LoanFailuresTest} from "./loan-failures.t.sol";
import {LoanSecurityTest} from "./loan-security.t.sol";
import {CcipEndpoint} from "../src/shared/ccip-endpoint.sol";
import {HedgeTypes} from "../src/shared/hedge-types.sol";
import {Client} from "../vendor/ccip-2.0.0/libraries/Client.sol";
import {IAny2EVMMessageReceiverV2} from "../vendor/ccip-2.0.0/interfaces/IAny2EVMMessageReceiverV2.sol";
import {ExtraArgsCodec} from "../vendor/ccip-2.0.0/libraries/ExtraArgsCodec.sol";
import {FinalityCodec} from "../vendor/ccip-2.0.0/libraries/FinalityCodec.sol";

// Exercise lifecycle, token failures and adversarial sequences with the fast
// Base policy too. Mocks test admission; live CCIP timing is separate evidence.
contract FastLifecycleTest is LoanLifecycleTest {
    function _baseConfirmations() internal pure override returns (uint16) {
        return 5;
    }
}

contract FastFailuresTest is LoanFailuresTest {
    function _baseConfirmations() internal pure override returns (uint16) {
        return 5;
    }
}

contract FastSecurityTest is LoanSecurityTest {
    function _baseConfirmations() internal pure override returns (uint16) {
        return 5;
    }
}

contract LoanFinalityTest is LoanFixture {
    function _baseConfirmations() internal pure override returns (uint16) {
        return 5;
    }

    function testPolicyIsPinnedByDirectionAndUsesDefaultVerifiers() public view {
        require(vault.requestedFinalityConfig() == bytes4(uint32(5)));
        require(lending.allowedFinalityConfig() == bytes4(uint32(5)));
        require(lending.requestedFinalityConfig() == bytes4(0) && vault.allowedFinalityConfig() == bytes4(0));
        require(lending.supportsInterface(type(IAny2EVMMessageReceiverV2).interfaceId));
        (address[] memory required, address[] memory optional, uint8 threshold, bytes4 finality) =
            lending.getCCVsAndFinalityConfig(BASE_SELECTOR, abi.encode(address(vault)));
        require(required.length == 0 && optional.length == 0 && threshold == 0 && finality == bytes4(uint32(5)));
    }

    function testPolicyRejectsWrongChainSenderAndEncoding() public {
        vm.expectRevert(CcipEndpoint.Unauthorized.selector);
        lending.getCCVsAndFinalityConfig(HEDERA_SELECTOR, abi.encode(address(vault)));
        vm.expectRevert(CcipEndpoint.Unauthorized.selector);
        lending.getCCVsAndFinalityConfig(BASE_SELECTOR, abi.encode(STRANGER));
        vm.expectRevert(CcipEndpoint.Unauthorized.selector);
        lending.getCCVsAndFinalityConfig(BASE_SELECTOR, abi.encodePacked(address(vault)));
    }

    function testWeakerCustodyPolicyCannotFundButFullFinalityCan() public {
        bytes32 id = _accept();
        _authorize(id);
        _lock(id);
        _send(vault, id, HedgeTypes.Kind.Custody);
        Client.Any2EVMMessage memory message = _message(baseRouter.getPacket(1));
        bytes memory weaker = ExtraArgsCodec._getBasicEncodedExtraArgsV3BlockDepth(1000000, 4);
        vm.expectRevert(
            abi.encodeWithSelector(
                FinalityCodec.InvalidRequestedFinality.selector, bytes4(uint32(4)), bytes4(uint32(5))
            )
        );
        hederaRouter.routeWithPolicy(address(lending), message, weaker);
        require(lending.getLoan(id).state == HedgeTypes.LoanState.Accepted && token.balanceOf(BORROWER) == 0);
        hederaRouter.routeWithPolicy(
            address(lending), message, ExtraArgsCodec._getBasicEncodedExtraArgsV3(1000000, bytes4(0))
        );
        require(lending.getLoan(id).state == HedgeTypes.LoanState.Funded && token.balanceOf(BORROWER) == 1000000);
    }

    function testFastAgreementCannotBypassFullFinalityOnBase() public {
        bytes32 id = _accept();
        _send(lending, id, HedgeTypes.Kind.Agreement);
        Client.Any2EVMMessage memory message = _message(hederaRouter.getPacket(1));
        vm.expectRevert(
            abi.encodeWithSelector(FinalityCodec.InvalidRequestedFinality.selector, bytes4(uint32(5)), bytes4(0))
        );
        baseRouter.routeWithPolicy(
            address(vault), message, ExtraArgsCodec._getBasicEncodedExtraArgsV3BlockDepth(1000000, 5)
        );
        require(!vault.getCustody(id).authorized);
        hederaRouter.deliverWithPolicy(1, baseRouter);
        require(vault.getCustody(id).authorized);
    }

    function testRetryPreservesPolicyAndPayloadWhenGasChanges() public {
        bytes32 id = _accept();
        _authorize(id);
        _lock(id);
        _send(vault, id, HedgeTypes.Kind.Custody);
        bytes32 operation = vault.operationId(id, HedgeTypes.Kind.Custody);
        vault.sendMessage{value: vault.quoteMessage(operation, 1500000)}(operation, 1500000);
        require(keccak256(baseRouter.getPacket(1).data) == keccak256(baseRouter.getPacket(2).data));
        bytes memory expected = ExtraArgsCodec._getBasicEncodedExtraArgsV3BlockDepth(1500000, 5);
        require(keccak256(baseRouter.getPacket(2).extraArgs) == keccak256(expected));
        baseRouter.deliverWithPolicy(2, hederaRouter);
        baseRouter.deliverWithPolicy(1, hederaRouter);
        require(token.balanceOf(BORROWER) == 1000000 && lending.capital(OPERATOR) == 9000000);
    }

    function testGasLimitCannotOverflowV3Encoding() public {
        bytes32 id = _accept();
        bytes32 operation = lending.operationId(id, HedgeTypes.Kind.Agreement);
        vm.expectRevert(CcipEndpoint.InvalidConfiguration.selector);
        lending.quoteMessage(operation, uint256(type(uint32).max) + 1);
        vm.expectRevert(CcipEndpoint.InvalidConfiguration.selector);
        lending.quoteMessage(operation, 0);
    }
}
