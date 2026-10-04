// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {SafeTransferLib} from "../src/shared/safe-transfer.sol";

contract TransferHarness {
    function transfer(address token) external {
        SafeTransferLib.safeTransfer(token, address(1), 1);
    }

    function approve(address token) external {
        SafeTransferLib.safeApprove(token, address(1), 1);
    }

    function transferFrom(address token) external {
        SafeTransferLib.safeTransferFrom(token, address(1), address(2), 1);
    }

    function balance(address token) external view returns (uint256) {
        return SafeTransferLib.balanceOf(token, address(1));
    }
}

contract FalseToken {
    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }

    function approve(address, uint256) external pure returns (bool) {
        return false;
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        return false;
    }
}

contract EmptyToken {
    uint256 public calls;

    function transfer(address, uint256) external {
        calls++;
    }

    function approve(address, uint256) external {
        calls++;
    }

    function transferFrom(address, address, uint256) external {
        calls++;
    }

    function balanceOf(address) external pure returns (uint256) {
        return 7;
    }
}

contract SafeTransferTest {
    TransferHarness harness = new TransferHarness();

    function testRejectsNoCode() public {
        try harness.transfer(address(1)) {
            revert("accepted no-code token");
        } catch (bytes memory reason) {
            require(bytes4(reason) == SafeTransferLib.InvalidToken.selector);
        }
    }

    function testRejectsFalseReturns() public {
        address token = address(new FalseToken());
        try harness.transfer(token) {
            revert("accepted failed transfer");
        } catch (bytes memory reason) {
            require(bytes4(reason) == SafeTransferLib.TransferFailed.selector);
        }
        try harness.transferFrom(token) {
            revert("accepted failed transferFrom");
        } catch (bytes memory reason) {
            require(bytes4(reason) == SafeTransferLib.TransferFailed.selector);
        }
        try harness.approve(token) {
            revert("accepted failed approve");
        } catch (bytes memory reason) {
            require(bytes4(reason) == SafeTransferLib.ApproveFailed.selector);
        }
    }

    function testSupportsNoReturnTokens() public {
        EmptyToken token = new EmptyToken();
        harness.transfer(address(token));
        harness.transferFrom(address(token));
        harness.approve(address(token));
        require(token.calls() == 3);
        require(harness.balance(address(token)) == 7);
    }
}
