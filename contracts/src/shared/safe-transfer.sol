// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

library SafeTransferLib {
    error InvalidToken();
    error TransferFailed();
    error ApproveFailed();

    function safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        if (token.code.length == 0) {
            revert InvalidToken();
        }
        (bool ok, bytes memory data) =
            token.call(abi.encodeWithSignature("transferFrom(address,address,uint256)", from, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) {
            revert TransferFailed();
        }
    }

    function safeTransfer(address token, address to, uint256 amount) internal {
        if (token.code.length == 0) {
            revert InvalidToken();
        }
        (bool ok, bytes memory data) = token.call(abi.encodeWithSignature("transfer(address,uint256)", to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) {
            revert TransferFailed();
        }
    }

    function safeApprove(address token, address spender, uint256 amount) internal {
        if (token.code.length == 0) {
            revert InvalidToken();
        }
        (bool ok, bytes memory data) = token.call(abi.encodeWithSignature("approve(address,uint256)", spender, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) {
            revert ApproveFailed();
        }
    }

    function balanceOf(address token, address account) internal view returns (uint256 value) {
        if (token.code.length == 0) {
            revert InvalidToken();
        }
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSignature("balanceOf(address)", account));
        if (!ok || data.length < 32) {
            revert InvalidToken();
        }
        value = abi.decode(data, (uint256));
    }
}
