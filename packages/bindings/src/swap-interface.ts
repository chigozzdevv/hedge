import { parseAbi } from "viem";
/** Minimal V1 router interface. These selectors have real testnet execution evidence.
 * SaucerSwap V1 follows IUniswapV2Router01; native output is HBAR (8 decimals).
 * https://github.com/Uniswap/v2-periphery/blob/master/contracts/interfaces/IUniswapV2Router01.sol
 * The Hedera wrapper Withdrawal event is checked against the deployed wrapper receipt.
 */
export const saucerRouterAbi = parseAbi([
  "function getAmountsOut(uint256 amountIn,address[] path) view returns (uint256[] amounts)",
  "function swapExactTokensForETH(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline) returns (uint256[] amounts)",
  "function swapExactETHForTokens(uint256 amountOutMin,address[] path,address to,uint256 deadline) payable returns (uint256[] amounts)",
]);
export const wrappedHbarAbi = parseAbi([
  "event Withdrawal(address indexed src,address indexed dst,uint256 wad)",
]);
