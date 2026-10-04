import type { TokenMetadata } from "@hedge/sdk";
import { formatAmount } from "@hedge/sdk";
export { formatAmount } from "@hedge/sdk";

export const tokenAmount = (amount: bigint, token: TokenMetadata) =>
  `${formatAmount(amount, token.decimals)} ${token.symbol}`;
export const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
export function formatDuration(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400} days`;
  if (seconds % 3600 === 0) return `${seconds / 3600} hours`;
  return `${seconds} seconds`;
}
