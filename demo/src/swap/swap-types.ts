import type { WalletIdentity } from "@hedge/sdk";

export interface SwapAsset {
  id: string;
  symbol: string;
  decimals: number;
  chain_id: number;
  /** Native HBAR has no token address and cannot be borrowed through Hedge. */
  token?: string;
}
export interface SwapRequest {
  chain_id: number;
  sell_asset: string;
  buy_asset: string;
  sell_amount: bigint;
  recipient: WalletIdentity;
  slippage_bps: number;
}
export type SwapEstimateRequest = Pick<
  SwapRequest,
  "chain_id" | "sell_asset" | "buy_asset" | "sell_amount"
>;
export interface SwapEstimate extends SwapEstimateRequest {
  buy_amount: bigint;
  expires_at: number;
}
export interface SwapQuote extends SwapRequest {
  id: string;
  buy_amount: bigint;
  minimum_received: bigint;
  /** Unix time in milliseconds. Execution must enforce this expiry and minimum output. */
  expires_at: number;
  network_fee: { amount: bigint; symbol: string; decimals: number };
}
export interface SwapReceipt {
  transaction_id: string;
  confirmed: true;
  request: SwapRequest;
  buy_amount: bigint;
}
/** Preserve the broadcast ID when broadcasting succeeds before a later error. */
export class SwapPendingError extends Error {
  constructor(public readonly transactionId: string) {
    super("Swap confirmation is pending.");
  }
}
/** Supply a real wallet, verified metadata, DEX quotes and chain receipts. */
export interface SwapServices {
  readonly assets: readonly SwapAsset[];
  /** Restrict controls to routes actually supported by the configured DEX service. */
  readonly routes?: readonly { sell: string; buy: string }[];
  wallet(): Promise<WalletIdentity | null>;
  connect(): Promise<WalletIdentity>;
  /** Spendable balance: reserve native gas where needed. */
  balance(asset: SwapAsset, wallet: WalletIdentity): Promise<bigint>;
  estimate?(request: SwapEstimateRequest): Promise<SwapEstimate>;
  quote(request: SwapRequest): Promise<SwapQuote>;
  /** Authorize this exact quote, obtain allowance if needed and return the broadcast ID. */
  execute(quote: SwapQuote): Promise<string>;
  /** Resolve after verified successful execution, separately from submission. */
  receipt(transactionId: string, quote: SwapQuote): Promise<SwapReceipt>;
  restore?(): Promise<{ transactionId: string; quote: SwapQuote } | null>;
  clearCheckpoint?(): void;
  loadDraft?(): { amount: string; sell: string; buy: string } | null;
  saveDraft?(draft: { amount: string; sell: string; buy: string }): void;
}
export interface SwapSnapshot {
  amount: string;
  sell: string;
  buy: string;
  busy: boolean;
  wallet?: WalletIdentity;
  balance?: bigint;
  estimate?: SwapEstimate;
  estimating?: boolean;
  estimateError?: string;
  quote?: SwapQuote;
  transactionId?: string;
  receipt?: SwapReceipt;
  error?: string;
}
