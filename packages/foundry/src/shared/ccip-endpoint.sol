// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Client} from "../../vendor/ccip-2.0.0/libraries/Client.sol";
import {IRouterClient} from "../../vendor/ccip-2.0.0/interfaces/IRouterClient.sol";
import {IAny2EVMMessageReceiver} from "../../vendor/ccip-2.0.0/interfaces/IAny2EVMMessageReceiver.sol";
import {IAny2EVMMessageReceiverV2} from "../../vendor/ccip-2.0.0/interfaces/IAny2EVMMessageReceiverV2.sol";
import {ExtraArgsCodec} from "../../vendor/ccip-2.0.0/libraries/ExtraArgsCodec.sol";
import {HedgeTypes} from "./hedge-types.sol";

abstract contract CcipEndpoint is IAny2EVMMessageReceiverV2 {
    struct Config {
        address deployer;
        address router;
        uint64 localSelector;
        uint64 remoteSelector;
        uint256 remoteChainId;
        // Zero requires full finality. Nonzero values admit that block depth.
        uint16 sendConfirmations;
        uint16 receiveConfirmations;
    }

    struct Outbox {
        bytes payload;
        bytes32 lastMessageId;
        uint256 submissions;
    }
    address public immutable deployer;
    address public immutable router;
    uint64 public immutable localSelector;
    uint64 public immutable remoteSelector;
    uint256 public immutable localChainId;
    uint256 public immutable remoteChainId;
    bytes4 public immutable requestedFinalityConfig;
    bytes4 public immutable allowedFinalityConfig;
    address public peer;
    bytes32 public instanceId;
    bool private entered;
    mapping(bytes32 => bytes32) public receivedMessages;
    mapping(bytes32 => Outbox) private outbox;

    error Unauthorized();
    error InvalidConfiguration();
    error AlreadyConfigured();
    error NotConfigured();
    error ReentrantCall();
    error InvalidMessage();
    error MissingObligation();
    error IncorrectFee(uint256 required);
    event PeerConfigured(address indexed peer, bytes32 indexed instanceId);
    event MessageRequired(bytes32 indexed operationId, bytes32 indexed loanId, HedgeTypes.Kind kind);
    event MessageSubmitted(bytes32 indexed operationId, bytes32 indexed messageId, uint256 gasLimit);
    event MessageReceived(bytes32 indexed messageId, bytes32 indexed loanId, HedgeTypes.Kind kind);

    constructor(Config memory config) {
        if (
            config.deployer == address(0) || config.router.code.length == 0 || config.localSelector == 0
                || config.remoteSelector == 0 || config.localSelector == config.remoteSelector
                || config.remoteChainId == 0 || config.remoteChainId == block.chainid
        ) {
            revert InvalidConfiguration();
        }
        deployer = config.deployer;
        router = config.router;
        localSelector = config.localSelector;
        remoteSelector = config.remoteSelector;
        localChainId = block.chainid;
        remoteChainId = config.remoteChainId;
        requestedFinalityConfig = bytes4(uint32(config.sendConfirmations));
        allowedFinalityConfig = bytes4(uint32(config.receiveConfirmations));
    }
    modifier nonReentrant() {
        if (entered) {
            revert ReentrantCall();
        }
        entered = true;
        _;
        entered = false;
    }
    modifier onlyDeployer() {
        if (msg.sender != deployer) {
            revert Unauthorized();
        }
        _;
    }
    modifier configured() {
        if (peer == address(0)) {
            revert NotConfigured();
        }
        _;
    }

    function configurePeer(address remotePeer) external onlyDeployer nonReentrant {
        if (peer != address(0)) {
            revert AlreadyConfigured();
        }
        if (remotePeer == address(0) || remotePeer == address(this)) {
            revert InvalidConfiguration();
        }
        if (!IRouterClient(router).isChainSupported(remoteSelector)) {
            revert InvalidConfiguration();
        }
        peer = remotePeer;
        (address lending, address vault, uint256 hederaId, uint256 baseId, uint64 hederaSel, uint64 baseSel) = _pair();
        instanceId = keccak256(abi.encode(HedgeTypes.VERSION, hederaId, baseId, hederaSel, baseSel, lending, vault));
        _configured();
        emit PeerConfigured(peer, instanceId);
    }

    function protocolVersion() external pure returns (uint16) {
        return HedgeTypes.VERSION;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 || interfaceId == type(IAny2EVMMessageReceiver).interfaceId
            || interfaceId == type(IAny2EVMMessageReceiverV2).interfaceId;
    }

    // The CCIP OffRamp enforces this policy before calling ccipReceive. Only the
    // frozen peer is admitted; retries cannot replace the policy or verifiers.
    function getCCVsAndFinalityConfig(uint64 sourceChainSelector, bytes calldata sender)
        external
        view
        configured
        returns (address[] memory requiredCCVs, address[] memory optionalCCVs, uint8 optionalThreshold, bytes4 finality)
    {
        if (sourceChainSelector != remoteSelector || sender.length != 32 || abi.decode(sender, (address)) != peer) {
            revert Unauthorized();
        }
        return (new address[](0), new address[](0), 0, allowedFinalityConfig);
    }

    function operationId(bytes32 loanId, HedgeTypes.Kind kind) public pure returns (bytes32) {
        return keccak256(abi.encode(loanId, kind));
    }

    function getOutbox(bytes32 id) external view returns (Outbox memory) {
        return outbox[id];
    }

    function quoteMessage(bytes32 id, uint256 gasLimit) external view configured returns (uint256) {
        return IRouterClient(router).getFee(remoteSelector, _buildMessage(id, gasLimit));
    }

    // State transitions persist the payload first. A failed send affects only this
    // submission. Anyone may sponsor/retry it; no caller can change the binding.
    function sendMessage(bytes32 id, uint256 gasLimit)
        external
        payable
        configured
        nonReentrant
        returns (bytes32 messageId)
    {
        Client.EVM2AnyMessage memory message = _buildMessage(id, gasLimit);
        uint256 fee = IRouterClient(router).getFee(remoteSelector, message);
        if (msg.value != fee) {
            revert IncorrectFee(fee);
        }
        messageId = IRouterClient(router).ccipSend{value: fee}(remoteSelector, message);
        if (messageId == bytes32(0)) {
            revert InvalidMessage();
        }
        outbox[id].lastMessageId = messageId;
        outbox[id].submissions++;
        emit MessageSubmitted(id, messageId, gasLimit);
    }

    function ccipReceive(Client.Any2EVMMessage calldata message) external configured nonReentrant {
        if (
            msg.sender != router || message.sourceChainSelector != remoteSelector || message.sender.length != 32
                || keccak256(message.sender) != keccak256(abi.encode(peer))
        ) {
            revert Unauthorized();
        }
        if (message.messageId == bytes32(0) || message.destTokenAmounts.length != 0) {
            revert InvalidMessage();
        }
        bytes32 fingerprint = keccak256(message.data);
        bytes32 seen = receivedMessages[message.messageId];
        if (seen != bytes32(0)) {
            if (seen != fingerprint) {
                revert InvalidMessage();
            }
            return;
        }
        HedgeTypes.Message memory payload = abi.decode(message.data, (HedgeTypes.Message));
        _validateMessage(payload);
        _receive(payload);
        receivedMessages[message.messageId] = fingerprint;
        emit MessageReceived(message.messageId, payload.agreement.loanId, payload.kind);
    }

    function _queue(HedgeTypes.Message memory message) internal {
        bytes32 id = operationId(message.agreement.loanId, message.kind);
        bytes memory payload = abi.encode(message);
        if (outbox[id].payload.length != 0) {
            if (keccak256(outbox[id].payload) != keccak256(payload)) {
                revert InvalidMessage();
            }
            return;
        }
        outbox[id].payload = payload;
        emit MessageRequired(id, message.agreement.loanId, message.kind);
    }

    function _buildMessage(bytes32 id, uint256 gasLimit) private view returns (Client.EVM2AnyMessage memory) {
        if (outbox[id].payload.length == 0) {
            revert MissingObligation();
        }
        if (gasLimit == 0 || gasLimit > type(uint32).max) {
            revert InvalidConfiguration();
        }
        return Client.EVM2AnyMessage({
            receiver: abi.encode(peer),
            data: outbox[id].payload,
            tokenAmounts: new Client.EVMTokenAmount[](0),
            feeToken: address(0),
            extraArgs: ExtraArgsCodec._getBasicEncodedExtraArgsV3(uint32(gasLimit), requestedFinalityConfig)
        });
    }

    function _validateMessage(HedgeTypes.Message memory message) private view {
        HedgeTypes.Agreement memory agreement = message.agreement;
        (address lending, address vault, uint256 hederaId, uint256 baseId, uint64 hederaSel, uint64 baseSel) = _pair();
        if (
            message.version != HedgeTypes.VERSION || agreement.version != HedgeTypes.VERSION
                || agreement.instanceId != instanceId || agreement.lending != lending || agreement.vault != vault
                || agreement.hederaChainId != hederaId || agreement.baseChainId != baseId
                || agreement.hederaSelector != hederaSel || agreement.baseSelector != baseSel
                || agreement.operator == address(0) || agreement.loanToken == address(0)
                || agreement.offerId == bytes32(0)
                || agreement.loanId != HedgeTypes.loanId(instanceId, agreement.offerId)
                || message.agreementHash != HedgeTypes.hash(agreement)
                || message.lockId != HedgeTypes.lockId(message.agreementHash)
        ) {
            revert HedgeTypes.InvalidAgreement();
        }
        HedgeTypes.validateTerms(agreement.terms);
        if (
            (message.kind == HedgeTypes.Kind.Outcome && message.outcome == HedgeTypes.Outcome.None)
                || (message.kind == HedgeTypes.Kind.Settlement && message.outcome != HedgeTypes.Outcome.Settle)
                || ((message.kind == HedgeTypes.Kind.Agreement || message.kind == HedgeTypes.Kind.Custody)
                    && message.outcome != HedgeTypes.Outcome.None)
        ) {
            revert InvalidMessage();
        }
    }
    function _pair() internal view virtual returns (address, address, uint256, uint256, uint64, uint64);
    function _configured() internal virtual {}
    function _receive(HedgeTypes.Message memory message) internal virtual;
}
