// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CcipEndpoint} from "../shared/ccip-endpoint.sol";
import {HedgeTypes} from "../shared/hedge-types.sol";
import {HtsToken} from "./hts-token.sol";

contract HedgeLending is CcipEndpoint {
    struct Offer {
        address operator;
        HedgeTypes.Terms terms;
        bytes32 termsHash;
        HedgeTypes.OfferState state;
    }

    struct Loan {
        HedgeTypes.Agreement agreement;
        bytes32 agreementHash;
        HedgeTypes.LoanState state;
        uint256 fundedAt;
        uint256 paymentDeadline;
    }
    address public immutable loanToken;
    address public immutable collateralAsset;
    mapping(address => uint256) public capital;
    mapping(address => uint256) public reservedCapital;
    mapping(address => uint256) public offerNonce;
    mapping(bytes32 => Offer) private offers;
    mapping(bytes32 => Loan) private loans;
    error InvalidState();
    error InsufficientCapital();
    error DeadlinePassed();
    error DeadlineNotPassed();
    error OfferChanged();
    error IncorrectRepayment();
    event CapitalDeposited(address indexed operator, uint256 amount);
    event CapitalWithdrawn(address indexed operator, uint256 amount);
    event OfferPublished(bytes32 indexed offerId, address indexed operator, bytes32 termsHash);
    event OfferWithdrawn(bytes32 indexed offerId);
    event LoanAccepted(bytes32 indexed loanId, bytes32 indexed offerId, bytes32 agreementHash);
    event LoanFunded(bytes32 indexed loanId, address recipient, uint256 principal, uint256 paymentDeadline);
    event LoanFinalized(bytes32 indexed loanId, HedgeTypes.LoanState state);
    event CollateralRepaymentRequested(bytes32 indexed loanId, uint256 amount);
    event CollateralRepaid(bytes32 indexed loanId, address indexed recipient, uint256 amount);

    constructor(Config memory config, address token, address baseAsset) CcipEndpoint(config) {
        if (token == address(0) || baseAsset == address(0)) {
            revert InvalidConfiguration();
        }
        loanToken = token;
        collateralAsset = baseAsset;
    }

    function _configured() internal override {
        HtsToken.associate(loanToken);
    }

    function _pair() internal view override returns (address, address, uint256, uint256, uint64, uint64) {
        return (address(this), peer, localChainId, remoteChainId, localSelector, remoteSelector);
    }

    function freeCapital(address lender) public view returns (uint256) {
        return capital[lender] - reservedCapital[lender];
    }

    function getOffer(bytes32 id) external view returns (Offer memory) {
        return offers[id];
    }

    function getLoan(bytes32 id) external view returns (Loan memory) {
        return loans[id];
    }

    function deposit(uint256 amount) external configured nonReentrant {
        if (amount == 0) {
            revert InsufficientCapital();
        }
        HtsToken.pull(loanToken, msg.sender, amount);
        capital[msg.sender] += amount;
        emit CapitalDeposited(msg.sender, amount);
    }

    function withdraw(uint256 amount) external configured nonReentrant {
        if (amount == 0 || amount > freeCapital(msg.sender)) {
            revert InsufficientCapital();
        }
        capital[msg.sender] -= amount;
        HtsToken.push(loanToken, msg.sender, amount);
        emit CapitalWithdrawn(msg.sender, amount);
    }

    function publishOffer(HedgeTypes.Terms calldata terms) external configured nonReentrant returns (bytes32 id) {
        HedgeTypes.validateTerms(terms);
        if (
            terms.collateralAsset != collateralAsset || terms.fundingRecipient == address(this)
                || terms.returnRecipient == peer || terms.recoveryRecipient == peer
        ) {
            revert HedgeTypes.InvalidTerms();
        }
        if (block.timestamp > terms.acceptanceDeadline) {
            revert DeadlinePassed();
        }
        if (terms.principal > freeCapital(msg.sender)) {
            revert InsufficientCapital();
        }
        id = keccak256(abi.encode(instanceId, msg.sender, ++offerNonce[msg.sender]));
        bytes32 termsHash = keccak256(abi.encode(HedgeTypes.VERSION, instanceId, id, msg.sender, loanToken, terms));
        offers[id] = Offer(msg.sender, terms, termsHash, HedgeTypes.OfferState.Open);
        reservedCapital[msg.sender] += terms.principal;
        emit OfferPublished(id, msg.sender, termsHash);
    }

    function withdrawOffer(bytes32 id) external nonReentrant {
        if (msg.sender != offers[id].operator) {
            revert Unauthorized();
        }
        _withdrawOffer(id);
    }

    function expireOffer(bytes32 id) external nonReentrant {
        if (block.timestamp <= offers[id].terms.acceptanceDeadline) {
            revert DeadlineNotPassed();
        }
        _withdrawOffer(id);
    }

    function _withdrawOffer(bytes32 id) private {
        Offer storage offer = offers[id];
        if (offer.state != HedgeTypes.OfferState.Open) {
            revert InvalidState();
        }
        offer.state = HedgeTypes.OfferState.Withdrawn;
        reservedCapital[offer.operator] -= offer.terms.principal;
        emit OfferWithdrawn(id);
    }

    function accept(bytes32 offerId, bytes32 reviewedTermsHash)
        external
        configured
        nonReentrant
        returns (bytes32 loanId)
    {
        Offer storage offer = offers[offerId];
        if (offer.state != HedgeTypes.OfferState.Open) {
            revert InvalidState();
        }
        if (msg.sender != offer.terms.borrower) {
            revert Unauthorized();
        }
        if (reviewedTermsHash != offer.termsHash) {
            revert OfferChanged();
        }
        if (block.timestamp > offer.terms.acceptanceDeadline) {
            revert DeadlinePassed();
        }
        offer.state = HedgeTypes.OfferState.Accepted;
        loanId = HedgeTypes.loanId(instanceId, offerId);
        HedgeTypes.Agreement memory agreement = HedgeTypes.Agreement({
            version: HedgeTypes.VERSION,
            instanceId: instanceId,
            hederaChainId: localChainId,
            baseChainId: remoteChainId,
            hederaSelector: localSelector,
            baseSelector: remoteSelector,
            lending: address(this),
            vault: peer,
            operator: offer.operator,
            loanToken: loanToken,
            offerId: offerId,
            loanId: loanId,
            terms: offer.terms
        });
        bytes32 agreementHash = HedgeTypes.hash(agreement);
        loans[loanId] = Loan(agreement, agreementHash, HedgeTypes.LoanState.Accepted, 0, 0);
        _queue(_message(loans[loanId], HedgeTypes.Kind.Agreement, HedgeTypes.Outcome.None));
        emit LoanAccepted(loanId, offerId, agreementHash);
    }

    function cancel(bytes32 id) external nonReentrant {
        Loan storage loan = loans[id];
        if (loan.state != HedgeTypes.LoanState.Accepted) {
            revert InvalidState();
        }
        if (msg.sender != loan.agreement.terms.borrower && block.timestamp <= loan.agreement.terms.setupDeadline) {
            revert Unauthorized();
        }
        _cancel(loan);
    }

    function _cancel(Loan storage loan) private {
        loan.state = HedgeTypes.LoanState.Cancelled;
        reservedCapital[loan.agreement.operator] -= loan.agreement.terms.principal;
        _queue(_message(loan, HedgeTypes.Kind.Outcome, HedgeTypes.Outcome.Return));
        emit LoanFinalized(loan.agreement.loanId, loan.state);
    }

    function repay(bytes32 id, uint256 amount) external configured nonReentrant {
        Loan storage loan = loans[id];
        if (loan.state != HedgeTypes.LoanState.Funded) {
            revert InvalidState();
        }
        if (msg.sender != loan.agreement.terms.borrower) {
            revert Unauthorized();
        }
        if (block.timestamp > loan.paymentDeadline) {
            revert DeadlinePassed();
        }
        if (amount != loan.agreement.terms.repaymentAmount) {
            revert IncorrectRepayment();
        }
        loan.state = HedgeTypes.LoanState.Repaid;
        HtsToken.pull(loanToken, msg.sender, amount);
        capital[loan.agreement.operator] += amount;
        _queue(_message(loan, HedgeTypes.Kind.Outcome, HedgeTypes.Outcome.Return));
        emit LoanFinalized(id, loan.state);
    }

    function authorizeDefault(bytes32 id) external nonReentrant {
        Loan storage loan = loans[id];
        if (msg.sender != loan.agreement.operator) {
            revert Unauthorized();
        }
        if (loan.state != HedgeTypes.LoanState.Funded) {
            revert InvalidState();
        }
        if (block.timestamp <= loan.paymentDeadline) {
            revert DeadlineNotPassed();
        }
        loan.state = HedgeTypes.LoanState.Defaulted;
        _queue(_message(loan, HedgeTypes.Kind.Outcome, HedgeTypes.Outcome.Recover));
        emit LoanFinalized(id, loan.state);
    }

    function repayWithCollateral(bytes32 id, bytes32 reviewedAgreementHash) external configured nonReentrant {
        Loan storage loan = loans[id];
        if (loan.state != HedgeTypes.LoanState.Funded || loan.agreement.terms.collateralRepaymentAmount == 0) {
            revert InvalidState();
        }
        if (msg.sender != loan.agreement.terms.borrower) {
            revert Unauthorized();
        }
        if (reviewedAgreementHash != loan.agreementHash) {
            revert HedgeTypes.InvalidAgreement();
        }
        if (block.timestamp > loan.paymentDeadline) {
            revert DeadlinePassed();
        }
        // Freeze the disposition before authorizing Base. Repayment/default cannot race this settlement.
        loan.state = HedgeTypes.LoanState.Settling;
        _queue(_message(loan, HedgeTypes.Kind.Outcome, HedgeTypes.Outcome.Settle));
        emit CollateralRepaymentRequested(id, loan.agreement.terms.collateralRepaymentAmount);
    }

    function _receive(HedgeTypes.Message memory message) internal override {
        if (message.kind != HedgeTypes.Kind.Custody && message.kind != HedgeTypes.Kind.Settlement) {
            revert InvalidMessage();
        }
        Loan storage loan = loans[message.agreement.loanId];
        if (loan.state == HedgeTypes.LoanState.None || message.agreementHash != loan.agreementHash) {
            revert HedgeTypes.InvalidAgreement();
        }
        if (message.kind == HedgeTypes.Kind.Settlement) {
            if (loan.state == HedgeTypes.LoanState.Repaid) {
                return;
            }
            if (loan.state != HedgeTypes.LoanState.Settling) {
                revert InvalidState();
            }
            loan.state = HedgeTypes.LoanState.Repaid;
            // The operator was paid on Base. Hedera capital must remain backed by actual Hedera tokens.
            emit CollateralRepaid(
                message.agreement.loanId,
                loan.agreement.terms.recoveryRecipient,
                loan.agreement.terms.collateralRepaymentAmount
            );
            emit LoanFinalized(message.agreement.loanId, loan.state);
            return;
        }
        if (loan.state != HedgeTypes.LoanState.Accepted) {
            return;
        }
        if (block.timestamp > loan.agreement.terms.setupDeadline) {
            _cancel(loan);
            return;
        }
        loan.state = HedgeTypes.LoanState.Funded;
        loan.fundedAt = block.timestamp;
        loan.paymentDeadline = block.timestamp + loan.agreement.terms.duration + loan.agreement.terms.gracePeriod;
        uint256 principal = loan.agreement.terms.principal;
        reservedCapital[loan.agreement.operator] -= principal;
        capital[loan.agreement.operator] -= principal;
        HtsToken.push(loanToken, loan.agreement.terms.fundingRecipient, principal);
        emit LoanFunded(
            message.agreement.loanId, loan.agreement.terms.fundingRecipient, principal, loan.paymentDeadline
        );
    }

    function _message(Loan storage loan, HedgeTypes.Kind kind, HedgeTypes.Outcome outcome)
        private
        view
        returns (HedgeTypes.Message memory)
    {
        return HedgeTypes.Message(
            HedgeTypes.VERSION, kind, loan.agreement, loan.agreementHash, HedgeTypes.lockId(loan.agreementHash), outcome
        );
    }
}
