// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

library HedgeTypes {
    uint16 internal constant VERSION = 3;
    enum Kind {
        Agreement,
        Custody,
        Outcome,
        Settlement
    }
    enum LoanState {
        None,
        Accepted,
        Funded,
        Repaid,
        Cancelled,
        Defaulted,
        Settling
    }
    enum Outcome {
        None,
        Return,
        Recover,
        Settle
    }
    enum OfferState {
        None,
        Open,
        Accepted,
        Withdrawn
    }

    // Full repayment is a fixed total, including the financing charge. No APR,
    // partial payments, early-payment discount or separate cancellation charge.
    struct Terms {
        address borrower;
        address fundingRecipient;
        uint256 principal;
        uint256 repaymentAmount;
        address collateralAsset;
        uint256 collateralAmount;
        address collateralOwner;
        address returnRecipient;
        address recoveryRecipient;
        uint64 acceptanceDeadline;
        uint64 setupDeadline;
        uint32 duration;
        uint32 gracePeriod;
        bytes32 policyHash;
        // Zero disables collateral repayment. The operator fixes this Base asset amount before acceptance.
        uint256 collateralRepaymentAmount;
    }

    struct Agreement {
        uint16 version;
        bytes32 instanceId;
        uint256 hederaChainId;
        uint256 baseChainId;
        uint64 hederaSelector;
        uint64 baseSelector;
        address lending;
        address vault;
        address operator;
        address loanToken;
        bytes32 offerId;
        bytes32 loanId;
        Terms terms;
    }

    struct Message {
        uint16 version;
        Kind kind;
        Agreement agreement;
        bytes32 agreementHash;
        bytes32 lockId;
        Outcome outcome;
    }

    error InvalidTerms();
    error InvalidAgreement();

    function hash(Agreement memory agreement) internal pure returns (bytes32) {
        return keccak256(abi.encode(agreement));
    }

    function lockId(bytes32 agreementHash) internal pure returns (bytes32) {
        return keccak256(abi.encode("hedge-lock-v3", agreementHash));
    }

    function loanId(bytes32 instanceId, bytes32 offerId) internal pure returns (bytes32) {
        return keccak256(abi.encode("hedge-loan-v3", instanceId, offerId));
    }

    function validateTerms(Terms memory terms) internal pure {
        if (
            terms.borrower == address(0) || terms.fundingRecipient != terms.borrower || terms.principal == 0
                || terms.repaymentAmount < terms.principal || terms.repaymentAmount > uint256(uint64(type(int64).max))
                || terms.collateralAsset == address(0) || terms.collateralAmount == 0
                || terms.collateralOwner == address(0) || terms.returnRecipient == address(0)
                || terms.recoveryRecipient == address(0) || terms.acceptanceDeadline == 0
                || terms.setupDeadline <= terms.acceptanceDeadline || terms.duration == 0
                || terms.policyHash == bytes32(0) || terms.collateralRepaymentAmount > terms.collateralAmount
        ) {
            revert InvalidTerms();
        }
    }
}
