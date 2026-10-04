// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MockToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public returnFalse;
    bool public taxed;
    address public hookTarget;
    bytes public hookData;
    bool public hookSucceeded;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function setFaults(bool fail, bool fee) external {
        returnFalse = fail;
        taxed = fee;
    }

    function setHook(address target, bytes calldata data) external {
        hookTarget = target;
        hookData = data;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (returnFalse) {
            return false;
        }
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (returnFalse) {
            return false;
        }
        _pull(msg.sender, from, to, amount);
        return true;
    }

    function htsPull(address spender, address from, address to, uint256 amount) external {
        require(msg.sender == address(0x167), "not HTS");
        require(!returnFalse, "transfer failure");
        _pull(spender, from, to, amount);
    }

    function htsPush(address from, address to, uint256 amount) external {
        require(msg.sender == address(0x167), "not HTS");
        require(!returnFalse, "transfer failure");
        _move(from, to, amount);
    }

    function _pull(address spender, address from, address to, uint256 amount) private {
        uint256 approved = allowance[from][spender];
        require(approved >= amount, "allowance");
        allowance[from][spender] = approved - amount;
        _move(from, to, amount);
    }

    function _move(address from, address to, uint256 amount) private {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += taxed ? amount - 1 : amount;
        if (hookTarget != address(0)) {
            (hookSucceeded,) = hookTarget.call(hookData);
        }
    }
}
