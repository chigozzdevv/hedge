// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LoanFixture} from "./helpers/loan-fixture.sol";
import {HedgeTypes} from "../src/shared/hedge-types.sol";
import {HedgeLending} from "../src/hedera/hedge-lending.sol";
import {HedgeVault} from "../src/base/hedge-vault.sol";

contract LoanFuzzTest is LoanFixture {
    function testFuzzLifecycle(
        uint64 principalSeed,
        uint64 chargeSeed,
        uint64 pledgeSeed,
        uint16 delaySeed,
        uint8 branch
    ) public {
        HedgeTypes.Terms memory terms = _terms();
        terms.principal = uint256(principalSeed) % 100000 + 1;
        uint256 charge = uint256(chargeSeed) % 10000;
        terms.repaymentAmount = terms.principal + charge;
        terms.collateralAmount = uint256(pledgeSeed) % 1000000 + 1;
        bytes32 id = _acceptTerms(terms);
        _authorize(id);
        vm.warp(block.timestamp + uint256(delaySeed) % 1201);
        _lock(id);
        if (branch % 3 == 0) {
            vm.prank(BORROWER);
            lending.cancel(id);
            _confirm(id);
            require(token.balanceOf(BORROWER) == 0);
        } else {
            _confirm(id);
            baseRouter.redeliver(1, hederaRouter, keccak256("fuzz duplicate custody"));
            require(token.balanceOf(BORROWER) == terms.principal);
            if (branch % 3 == 1) {
                token.mint(BORROWER, charge);
                vm.prank(BORROWER);
                lending.repay(id, terms.repaymentAmount);
            } else {
                vm.warp(lending.getLoan(id).paymentDeadline + 1);
                vm.prank(OPERATOR);
                lending.authorizeDefault(id);
            }
        }
        _outcome(id);
        bool recovery = branch % 3 == 2;
        vm.prank(recovery ? RECOVERY : RETURN);
        vault.claim(id);
        require(asset.balanceOf(recovery ? RECOVERY : RETURN) == terms.collateralAmount);
        require(asset.balanceOf(recovery ? RETURN : RECOVERY) == 0 && vault.totalLocked() == 0);
        uint256 expectedCapital =
            branch % 3 == 0 ? 10000000 : branch % 3 == 1 ? 10000000 + charge : 10000000 - terms.principal;
        require(lending.capital(OPERATOR) == expectedCapital && lending.reservedCapital(OPERATOR) == 0);
        _assertCapital();
    }

    // Exercise arbitrary valid and invalid operation order on four concurrent
    // loans. Reverts are allowed; conservation/authority must hold after EVERY step.
    function testFuzzOperationSequences(bytes calldata actions) public {
        bytes32[4] memory ids;
        for (uint256 i = 0; i < ids.length; i++) {
            ids[i] = _accept();
        }
        token.mint(BORROWER, 40000);
        uint256 length = actions.length > 64 ? 64 : actions.length;
        for (uint256 i = 0; i < length; i++) {
            uint256 seed = uint8(actions[i]);
            bytes32 id = ids[seed % 4];
            uint256 action = seed / 4 % 10;
            if (action == 0) {
                _authorize(id);
            } else if (action == 1) {
                _callAs(OWNER, address(vault), abi.encodeCall(vault.lock, (id, lending.getLoan(id).agreementHash)));
            } else if (action == 2 && vault.getCustody(id).locked) {
                _send(vault, id, HedgeTypes.Kind.Custody);
                try baseRouter.deliver(baseRouter.count(), hederaRouter) {} catch {}
            } else if (action == 3) {
                _callAs(BORROWER, address(lending), abi.encodeCall(lending.cancel, (id)));
            } else if (action == 4) {
                _callAs(BORROWER, address(lending), abi.encodeCall(lending.repay, (id, 1010000)));
            } else if (action == 5) {
                _callAs(OPERATOR, address(lending), abi.encodeCall(lending.authorizeDefault, (id)));
            } else if (
                action == 6 && lending.getOutbox(lending.operationId(id, HedgeTypes.Kind.Outcome)).payload.length > 0
            ) {
                _outcome(id);
            } else if (action == 7) {
                address claimant = vault.getCustody(id).outcome == HedgeTypes.Outcome.Recover ? RECOVERY : RETURN;
                _callAs(claimant, address(vault), abi.encodeCall(vault.claim, (id)));
            } else if (action == 8) {
                vm.warp(block.timestamp + 20000);
            } else if (action == 9 && baseRouter.count() > 0) {
                try baseRouter.redeliver(seed % baseRouter.count() + 1, hederaRouter, keccak256(abi.encode(i, seed))) {}
                    catch {}
            }
            _assertConservation(ids);
        }
        _assertConservation(ids);
    }

    function _callAs(address sender, address target, bytes memory data) private {
        vm.prank(sender);
        (bool ok,) = target.call(data);
        // Invalid transitions revert; no success is inferred by the test driver.
        if (!ok) {
            return;
        }
    }

    function _assertConservation(bytes32[4] memory ids) private view {
        uint256 commitments;
        uint256 payouts;
        uint256 repayments;
        uint256 locked;
        uint256 returnedAmount;
        uint256 recoveries;
        uint256 allDeposits;
        for (uint256 i = 0; i < ids.length; i++) {
            HedgeLending.Loan memory loan = lending.getLoan(ids[i]);
            HedgeVault.Custody memory entry = vault.getCustody(ids[i]);
            if (loan.state == HedgeTypes.LoanState.Accepted) {
                commitments += 1000000;
            }
            if (loan.fundedAt != 0) {
                payouts += 1000000;
            }
            if (loan.state == HedgeTypes.LoanState.Repaid) {
                repayments += 1010000;
            }
            if (entry.locked) {
                allDeposits += 2000000;
            }
            if (entry.locked && !entry.claimed) {
                locked += 2000000;
            }
            if (entry.outcome == HedgeTypes.Outcome.Recover) {
                require(loan.state == HedgeTypes.LoanState.Defaulted, "unearned recovery");
            }
            if (entry.outcome == HedgeTypes.Outcome.Return) {
                require(
                    loan.state == HedgeTypes.LoanState.Repaid || loan.state == HedgeTypes.LoanState.Cancelled,
                    "unearned return"
                );
            }
            if (entry.claimed && entry.outcome == HedgeTypes.Outcome.Return) {
                returnedAmount += 2000000;
            }
            if (entry.claimed && entry.outcome == HedgeTypes.Outcome.Recover) {
                recoveries += 2000000;
            }
        }
        require(lending.reservedCapital(OPERATOR) == commitments, "reservation conservation");
        require(lending.capital(OPERATOR) == 10000000 - payouts + repayments, "capital conservation");
        require(token.balanceOf(address(lending)) == lending.capital(OPERATOR), "cash conservation");
        require(token.balanceOf(BORROWER) == 40000 + payouts - repayments, "single payout");
        require(vault.totalLocked() == locked && asset.balanceOf(address(vault)) == locked, "custody conservation");
        require(asset.balanceOf(OWNER) == 1000000000 - allDeposits, "exact deposits");
        require(
            asset.balanceOf(RETURN) == returnedAmount && asset.balanceOf(RECOVERY) == recoveries, "single disposition"
        );
        _assertCapital();
    }
}
