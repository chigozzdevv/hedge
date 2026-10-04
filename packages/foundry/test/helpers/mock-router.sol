// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Client} from "../../vendor/ccip-2.0.0/libraries/Client.sol";
import {IRouterClient} from "../../vendor/ccip-2.0.0/interfaces/IRouterClient.sol";
import {IAny2EVMMessageReceiver} from "../../vendor/ccip-2.0.0/interfaces/IAny2EVMMessageReceiver.sol";
import {IAny2EVMMessageReceiverV2} from "../../vendor/ccip-2.0.0/interfaces/IAny2EVMMessageReceiverV2.sol";
import {ExtraArgsCodec} from "../../vendor/ccip-2.0.0/libraries/ExtraArgsCodec.sol";
import {FinalityCodec} from "../../vendor/ccip-2.0.0/libraries/FinalityCodec.sol";
import {CcipEndpoint} from "../../src/shared/ccip-endpoint.sol";

contract MockRouter is IRouterClient {
    struct Packet {
        bytes32 id;
        uint64 source;
        address sender;
        address receiver;
        bytes data;
        bytes extraArgs;
    }
    mapping(uint256 => Packet) private packets;
    uint256 public count;
    uint256 public fee = 1;
    bool public failSend;
    bool public supported = true;

    function setFailure(bool value) external {
        failSend = value;
    }

    function setSupported(bool value) external {
        supported = value;
    }

    function setFee(uint256 value) external {
        fee = value;
    }

    function isChainSupported(uint64) external view returns (bool) {
        return supported;
    }

    function getFee(uint64, Client.EVM2AnyMessage memory) external view returns (uint256) {
        return fee;
    }

    function getPacket(uint256 id) external view returns (Packet memory) {
        return packets[id];
    }

    function ccipSend(uint64 selector, Client.EVM2AnyMessage calldata message) external payable returns (bytes32 id) {
        require(!failSend, "send failed");
        require(msg.value == fee && supported && selector == CcipEndpoint(msg.sender).remoteSelector(), "send config");
        require(message.tokenAmounts.length == 0 && message.feeToken == address(0), "message-only native fees");
        id = keccak256(abi.encode(address(this), ++count));
        packets[count] = Packet(
            id,
            CcipEndpoint(msg.sender).localSelector(),
            msg.sender,
            abi.decode(message.receiver, (address)),
            message.data,
            message.extraArgs
        );
    }

    function deliver(uint256 index, MockRouter destination) external {
        _deliver(index, destination, bytes32(0));
    }

    function redeliver(uint256 index, MockRouter destination, bytes32 freshId) external {
        _deliver(index, destination, freshId);
    }

    function _deliver(uint256 index, MockRouter destination, bytes32 freshId) private {
        Packet memory packet = packets[index];
        require(packet.id != bytes32(0), "missing packet");
        destination.route(
            packet.receiver,
            Client.Any2EVMMessage({
                messageId: freshId == bytes32(0) ? packet.id : freshId,
                sourceChainSelector: packet.source,
                sender: abi.encode(packet.sender),
                data: packet.data,
                destTokenAmounts: new Client.EVMTokenAmount[](0)
            })
        );
    }

    // Mirrors the finality admission gate, not CCIP consensus or verification.
    function deliverWithPolicy(uint256 index, MockRouter destination) external {
        Packet memory packet = packets[index];
        destination.routeWithPolicy(
            packet.receiver,
            Client.Any2EVMMessage({
                messageId: packet.id,
                sourceChainSelector: packet.source,
                sender: abi.encode(packet.sender),
                data: packet.data,
                destTokenAmounts: new Client.EVMTokenAmount[](0)
            }),
            packet.extraArgs
        );
    }

    function routeWithPolicy(address receiver, Client.Any2EVMMessage memory message, bytes calldata extraArgs)
        external
    {
        ExtraArgsCodec.GenericExtraArgsV3 memory args = ExtraArgsCodec._decodeGenericExtraArgsV3(extraArgs);
        (,,, bytes4 allowed) =
            IAny2EVMMessageReceiverV2(receiver).getCCVsAndFinalityConfig(message.sourceChainSelector, message.sender);
        FinalityCodec._ensureRequestedFinalityAllowed(args.requestedFinalityConfig, allowed);
        IAny2EVMMessageReceiver(receiver).ccipReceive(message);
    }

    function route(address receiver, Client.Any2EVMMessage memory message) external {
        IAny2EVMMessageReceiver(receiver).ccipReceive(message);
    }

    function routeWithGas(address receiver, Client.Any2EVMMessage memory message, uint256 gasLimit) external {
        IAny2EVMMessageReceiver(receiver).ccipReceive{gas: gasLimit}(message);
    }
}
