// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CcipEndpoint} from "../shared/ccip-endpoint.sol";
import {HedgeTypes} from "../shared/hedge-types.sol";
import {SafeTransferLib} from "../shared/safe-transfer.sol";

contract HedgeVault is CcipEndpoint {
    struct Custody {
        HedgeTypes.Agreement agreement;
        bytes32 agreementHash;
        bool authorized;
        bool locked;
        bool claimed;
        HedgeTypes.Outcome outcome;
    }
    address public immutable collateralAsset;
    uint256 public totalLocked;
    mapping(bytes32 => Custody) private custody;
    error InvalidState();
    error DeadlinePassed();
    error InexactTransfer();
    error ConflictingOutcome();
    event AgreementAuthorized(bytes32 indexed loanId, bytes32 agreementHash);
    event CollateralLocked(bytes32 indexed loanId, bytes32 indexed lockId, uint256 amount);
    event OutcomeAuthorized(bytes32 indexed loanId, HedgeTypes.Outcome outcome);
    event CollateralClaimed(bytes32 indexed loanId, address indexed recipient, uint256 amount);
    event CollateralSettled(
        bytes32 indexed loanId, address indexed recipient, uint256 repayment, uint256 returnedAmount
    );

    constructor(Config memory config, address asset) CcipEndpoint(config) {
        if (asset.code.length == 0) {
            revert InvalidConfiguration();
        }
        collateralAsset = asset;
    }

    function _pair() internal view override returns (address, address, uint256, uint256, uint64, uint64) {
        return (peer, address(this), remoteChainId, localChainId, remoteSelector, localSelector);
    }

    function getCustody(bytes32 id) external view returns (Custody memory) {
        return custody[id];
    }

    function lock(bytes32 id, bytes32 reviewedAgreementHash) external configured nonReentrant {
        Custody storage entry = custody[id];
        if (!entry.authorized || entry.locked || entry.claimed || entry.outcome != HedgeTypes.Outcome.None) {
            revert InvalidState();
        }
        if (reviewedAgreementHash != entry.agreementHash) {
            revert HedgeTypes.InvalidAgreement();
        }
        HedgeTypes.Terms storage terms = entry.agreement.terms;
        if (msg.sender != terms.collateralOwner) {
            revert Unauthorized();
        }
        if (block.timestamp > terms.setupDeadline) {
            revert DeadlinePassed();
        }
        uint256 target = SafeTransferLib.balanceOf(collateralAsset, address(this));
        uint256 source = SafeTransferLib.balanceOf(collateralAsset, msg.sender);
        if (target < totalLocked) {
            revert InexactTransfer();
        }
        entry.locked = true;
        totalLocked += terms.collateralAmount;
        SafeTransferLib.safeTransferFrom(collateralAsset, msg.sender, address(this), terms.collateralAmount);
        if (
            SafeTransferLib.balanceOf(collateralAsset, address(this)) != target + terms.collateralAmount
                || SafeTransferLib.balanceOf(collateralAsset, msg.sender) + terms.collateralAmount != source
        ) {
            revert InexactTransfer();
        }
        _queue(
            HedgeTypes.Message(
                HedgeTypes.VERSION,
                HedgeTypes.Kind.Custody,
                entry.agreement,
                entry.agreementHash,
                HedgeTypes.lockId(entry.agreementHash),
                HedgeTypes.Outcome.None
            )
        );
        emit CollateralLocked(id, HedgeTypes.lockId(entry.agreementHash), terms.collateralAmount);
    }

    function claim(bytes32 id) external nonReentrant {
        Custody storage entry = custody[id];
        if (
            !entry.locked || entry.claimed
                || (entry.outcome != HedgeTypes.Outcome.Return && entry.outcome != HedgeTypes.Outcome.Recover)
        ) {
            revert InvalidState();
        }
        HedgeTypes.Terms storage terms = entry.agreement.terms;
        address recipient = entry.outcome == HedgeTypes.Outcome.Return ? terms.returnRecipient : terms.recoveryRecipient;
        if (
            msg.sender != recipient
                && !(entry.outcome == HedgeTypes.Outcome.Return && msg.sender == terms.collateralOwner)
        ) {
            revert Unauthorized();
        }
        uint256 amount = terms.collateralAmount;
        uint256 source = SafeTransferLib.balanceOf(collateralAsset, address(this));
        uint256 target = SafeTransferLib.balanceOf(collateralAsset, recipient);
        if (source < totalLocked) {
            revert InexactTransfer();
        }
        entry.claimed = true;
        totalLocked -= amount;
        SafeTransferLib.safeTransfer(collateralAsset, recipient, amount);
        if (
            SafeTransferLib.balanceOf(collateralAsset, address(this)) + amount != source
                || SafeTransferLib.balanceOf(collateralAsset, recipient) != target + amount
        ) {
            revert InexactTransfer();
        }
        emit CollateralClaimed(id, recipient, amount);
    }

    // Anyone can finish a borrower-authorized settlement, but the agreement fixes both recipients and amounts.
    function settle(bytes32 id) external configured nonReentrant {
        Custody storage entry = custody[id];
        if (!entry.locked || entry.claimed || entry.outcome != HedgeTypes.Outcome.Settle) {
            revert InvalidState();
        }
        HedgeTypes.Terms storage terms = entry.agreement.terms;
        uint256 paid = terms.collateralRepaymentAmount;
        if (paid == 0 || paid > terms.collateralAmount) {
            revert HedgeTypes.InvalidTerms();
        }
        uint256 returnedAmount = terms.collateralAmount - paid;
        entry.claimed = true;
        totalLocked -= terms.collateralAmount;
        _transferExact(terms.recoveryRecipient, paid);
        if (returnedAmount != 0) {
            _transferExact(terms.returnRecipient, returnedAmount);
        }
        _queue(
            HedgeTypes.Message(
                HedgeTypes.VERSION,
                HedgeTypes.Kind.Settlement,
                entry.agreement,
                entry.agreementHash,
                HedgeTypes.lockId(entry.agreementHash),
                HedgeTypes.Outcome.Settle
            )
        );
        emit CollateralSettled(id, terms.recoveryRecipient, paid, returnedAmount);
    }

    function _transferExact(address recipient, uint256 amount) private {
        uint256 source = SafeTransferLib.balanceOf(collateralAsset, address(this));
        uint256 target = SafeTransferLib.balanceOf(collateralAsset, recipient);
        if (source < totalLocked + amount) {
            revert InexactTransfer();
        }
        SafeTransferLib.safeTransfer(collateralAsset, recipient, amount);
        if (
            SafeTransferLib.balanceOf(collateralAsset, address(this)) != source - amount
                || SafeTransferLib.balanceOf(collateralAsset, recipient) != target + amount
        ) {
            revert InexactTransfer();
        }
    }

    function _receive(HedgeTypes.Message memory message) internal override {
        if (message.kind == HedgeTypes.Kind.Custody || message.kind == HedgeTypes.Kind.Settlement) {
            revert InvalidMessage();
        }
        HedgeTypes.Terms memory terms = message.agreement.terms;
        if (
            terms.collateralAsset != collateralAsset || terms.returnRecipient == address(this)
                || terms.recoveryRecipient == address(this)
        ) {
            revert HedgeTypes.InvalidAgreement();
        }
        Custody storage entry = custody[message.agreement.loanId];
        if (entry.agreementHash == bytes32(0)) {
            entry.agreement = message.agreement;
            entry.agreementHash = message.agreementHash;
        } else if (entry.agreementHash != message.agreementHash) {
            revert HedgeTypes.InvalidAgreement();
        }
        if (message.kind == HedgeTypes.Kind.Agreement) {
            if (!entry.authorized) {
                entry.authorized = true;
                emit AgreementAuthorized(message.agreement.loanId, message.agreementHash);
            }
        } else {
            if (entry.outcome != HedgeTypes.Outcome.None && entry.outcome != message.outcome) {
                revert ConflictingOutcome();
            }
            if (entry.outcome == HedgeTypes.Outcome.None) {
                entry.outcome = message.outcome;
                emit OutcomeAuthorized(message.agreement.loanId, message.outcome);
            }
        }
    }
}
