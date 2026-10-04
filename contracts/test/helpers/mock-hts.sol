// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockToken} from "./mock-token.sol";
import {IHtsTokenService} from "../../src/hedera/hts-token.sol";

// Models response codes, associations and spender-specific HTS allowances at
// 0x167. This is fault injection, not a Hedera node implementation.
contract MockHts {
    mapping(address => mapping(address => bool)) public associated;
    int64 public failureCode;
    int64 public associationFailure;

    function setAssociationFailure(int64 value) external {
        associationFailure = value;
    }
    int32 public tokenType;
    bool public customFee;

    function simulateAutoAssociation(address account, address token) external {
        associated[account][token] = true;
    }

    function setCustomFee(bool value) external {
        customFee = value;
    }

    function getTokenCustomFees(address)
        external
        view
        returns (
            int64,
            IHtsTokenService.FixedFee[] memory,
            IHtsTokenService.FractionalFee[] memory,
            IHtsTokenService.RoyaltyFee[] memory
        )
    {
        return (
            failureCode == 0 ? int64(22) : failureCode,
            new IHtsTokenService.FixedFee[](customFee ? 1 : 0),
            new IHtsTokenService.FractionalFee[](0),
            new IHtsTokenService.RoyaltyFee[](0)
        );
    }

    function setFailure(int64 code) external {
        failureCode = code;
    }

    function setTokenType(int32 value) external {
        tokenType = value;
    }

    function getTokenType(address) external view returns (int64, int32) {
        return (failureCode == 0 ? int64(22) : failureCode, tokenType);
    }

    function associateToken(address account, address token) external returns (int64) {
        if (failureCode != 0) {
            return failureCode;
        }
        if (associationFailure != 0) {
            return associationFailure;
        }
        require(msg.sender == account, "association authority");
        if (associated[account][token]) {
            return 194;
        }
        associated[account][token] = true;
        return 22;
    }

    function transferFrom(address token, address from, address to, uint256 amount) external returns (int64) {
        if (failureCode != 0) {
            return failureCode;
        }
        if (!associated[from][token] || !associated[to][token]) {
            return 999;
        }
        try MockToken(token).htsPull(msg.sender, from, to, amount) {
            return 22;
        } catch {
            return 999;
        }
    }

    function transferToken(address token, address from, address to, int64 amount) external returns (int64) {
        if (failureCode != 0) {
            return failureCode;
        }
        require(from == msg.sender && amount > 0, "transfer authority");
        if (!associated[from][token] || !associated[to][token]) {
            return 999;
        }
        try MockToken(token).htsPush(from, to, uint256(uint64(amount))) {
            return 22;
        } catch {
            return 999;
        }
    }
}
