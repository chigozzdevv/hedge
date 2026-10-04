// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Minimal Foundry cheatcode surface used by this test suite.
interface TestVm {
    function warp(uint256 timestamp) external;
    function chainId(uint256 chainId) external;
    function prank(address sender) external;
    function startPrank(address sender) external;
    function stopPrank() external;
    function deal(address account, uint256 balance) external;
    function etch(address target, bytes calldata code) external;
    function expectRevert(bytes4 selector) external;
    function expectRevert() external;
    function expectRevert(bytes calldata data) external;
}
