import { formatAmount, sameAddress, type WalletIdentity, type FundingResult } from "@hedge/sdk";
import { parseAmount } from "@hedge/schema";
import { formatUnits } from "viem";
import {
  SwapPendingError,
  type SwapAsset,
  type SwapRequest,
  type SwapServices,
  type SwapSnapshot,
  type SwapEstimateRequest,
} from "./swap-types";

export { parseAmount } from "@hedge/schema";
const sameWallet = (a: WalletIdentity, b: WalletIdentity) =>
  a.chain_id === b.chain_id && sameAddress(a.address, b.address) && a.account_id === b.account_id;
const sameEstimate = (a: SwapEstimateRequest, b: SwapEstimateRequest) =>
  a.chain_id === b.chain_id &&
  a.sell_asset === b.sell_asset &&
  a.buy_asset === b.buy_asset &&
  a.sell_amount === b.sell_amount;
const sameRequest = (a: SwapRequest, b: SwapRequest) =>
  sameEstimate(a, b) && a.slippage_bps === b.slippage_bps && sameWallet(a.recipient, b.recipient);
const displayAssets = Object.freeze([
  { id: "usdc", symbol: "USDC" },
  { id: "hbar", symbol: "HBAR" },
]);

export class SwapController {
  readonly assets: readonly { id: string; symbol: string }[];
  private snapshot: SwapSnapshot;
  private listeners = new Set<() => void>();
  private estimateVersion = 0;
  constructor(readonly services?: SwapServices) {
    const assets = services?.assets;
    if (
      assets &&
      (assets.length < 2 ||
        new Set(assets.map((asset) => asset.id)).size !== assets.length ||
        assets.some(
          (asset) =>
            !asset.id ||
            !asset.symbol ||
            asset.symbol.length > 16 ||
            !Number.isInteger(asset.decimals) ||
            asset.decimals < 0 ||
            asset.decimals > 77 ||
            !Number.isSafeInteger(asset.chain_id) ||
            asset.chain_id <= 0 ||
            asset.chain_id !== assets[0].chain_id ||
            (asset.token !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(asset.token)),
        ))
    )
      throw new Error("Invalid swap asset configuration.");
    this.assets = assets
      ? Object.freeze(assets.map((asset) => Object.freeze({ ...asset })))
      : displayAssets;
    this.snapshot = { amount: "", sell: this.assets[0].id, buy: this.assets[1].id, busy: false };
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(value: Partial<SwapSnapshot>) {
    this.snapshot = { ...this.snapshot, ...value };
    this.listeners.forEach((listener) => listener());
  }
  private async run(action: () => Promise<void>) {
    if (this.snapshot.busy) return;
    this.estimateVersion++;
    this.update({ busy: true, estimating: false, error: undefined });
    try {
      await action();
    } catch (error) {
      this.update({ error: error instanceof Error ? error.message : "Please try again." });
    } finally {
      this.update({ busy: false });
    }
  }
  private provider() {
    if (!this.services) throw new Error("Wallet connection is unavailable.");
    return this.services;
  }
  supports(sell: string, buy: string) {
    return (
      !this.services?.routes ||
      this.services.routes.some((route) => route.sell === sell && route.buy === buy)
    );
  }
  private saveDraft() {
    const { amount, sell, buy } = this.snapshot;
    this.services?.saveDraft?.({ amount, sell, buy });
  }
  private asset(id: string): SwapAsset {
    const asset = this.assets.find((value) => value.id === id);
    if (!asset || !("decimals" in asset)) throw new Error("Swap quotes are unavailable.");
    return asset as SwapAsset;
  }
  token(id: string): SwapAsset | undefined {
    return this.services ? this.asset(id) : undefined;
  }
  private wallet(value: WalletIdentity | null): WalletIdentity {
    if (!value) throw new Error("Connect your Hedera wallet.");
    if (
      value.chain_id !== this.asset(this.snapshot.sell).chain_id ||
      !/^0x[0-9a-fA-F]{40}$/.test(value.address) ||
      !/^0\.0\.[0-9]+$/.test(value.account_id ?? "")
    )
      throw new Error("Connect a wallet on the selected Hedera network.");
    return Object.freeze({ ...value });
  }
  private async readWallet() {
    const wallet = this.wallet(await this.provider().wallet());
    const balance = await this.provider().balance(this.asset(this.snapshot.sell), wallet);
    if (typeof balance !== "bigint" || balance < 0n)
      throw new Error("Unable to read your balance.");
    this.update({ wallet, balance });
    return wallet;
  }
  initialize = () =>
    this.run(async () => {
      if (!this.services) return;
      const draft = this.services.loadDraft?.();
      if (
        draft &&
        typeof draft.amount === "string" &&
        draft.amount.length <= 100 &&
        this.assets.some((asset) => asset.id === draft.sell) &&
        this.assets.some((asset) => asset.id === draft.buy) &&
        this.supports(draft.sell, draft.buy)
      )
        this.update(draft);
      if (await this.services.wallet()) await this.readWallet();
      const restored = await this.services.restore?.();
      if (restored) {
        const wallet = this.wallet(await this.services.wallet());
        if (!sameWallet(restored.quote.recipient, wallet))
          throw new Error("Connect the wallet for your saved swap");
        this.update({
          sell: restored.quote.sell_asset,
          buy: restored.quote.buy_asset,
          amount: formatAmount(
            restored.quote.sell_amount,
            this.asset(restored.quote.sell_asset).decimals,
          ),
          quote: restored.quote,
          transactionId: restored.transactionId,
        });
        await this.confirmReceipt();
      }
    });
  connect = () =>
    this.run(async () => {
      if (this.snapshot.transactionId) throw new Error("Check your pending swap first.");
      this.wallet(await this.provider().connect());
      this.update({ quote: undefined });
      await this.readWallet();
    });
  setAmount = (amount: string) => {
    if (!this.snapshot.busy && !this.snapshot.transactionId) {
      this.estimateVersion++;
      this.update({
        amount,
        quote: undefined,
        receipt: undefined,
        error: undefined,
        estimate: undefined,
        estimating: false,
        estimateError: undefined,
      });
      this.saveDraft();
    }
  };
  select = (side: "sell" | "buy", id: string) => {
    if (
      this.snapshot.busy ||
      this.snapshot.transactionId ||
      !this.assets.some((asset) => asset.id === id)
    )
      return;
    const other = side === "sell" ? "buy" : "sell";
    const sell =
      side === "sell" ? id : id === this.snapshot.sell ? this.snapshot.buy : this.snapshot.sell;
    const buy =
      side === "buy" ? id : id === this.snapshot.buy ? this.snapshot.sell : this.snapshot.buy;
    if (!this.supports(sell, buy)) return;
    this.estimateVersion++;
    this.update({
      [side]: id,
      ...(id === this.snapshot[other] ? { [other]: this.snapshot[side] } : {}),
      balance: undefined,
      quote: undefined,
      receipt: undefined,
      error: undefined,
      estimate: undefined,
      estimating: false,
      estimateError: undefined,
    });
    this.saveDraft();
  };
  reverse = () => this.select("sell", this.snapshot.buy);
  back = () => {
    if (!this.snapshot.busy && !this.snapshot.transactionId)
      this.update({ quote: undefined, error: undefined });
  };
  private request(wallet: WalletIdentity): SwapRequest {
    return {
      chain_id: wallet.chain_id,
      sell_asset: this.snapshot.sell,
      buy_asset: this.snapshot.buy,
      sell_amount: parseAmount(this.snapshot.amount, this.asset(this.snapshot.sell).decimals),
      recipient: wallet,
      slippage_bps: 50,
    };
  }
  preview = async () => {
    if (
      this.snapshot.busy ||
      this.snapshot.quote ||
      this.snapshot.transactionId ||
      !this.services?.estimate
    )
      return;
    const version = ++this.estimateVersion;
    let request: SwapEstimateRequest;
    try {
      request = {
        chain_id: this.asset(this.snapshot.sell).chain_id,
        sell_asset: this.snapshot.sell,
        buy_asset: this.snapshot.buy,
        sell_amount: parseAmount(this.snapshot.amount, this.asset(this.snapshot.sell).decimals),
      };
    } catch {
      this.update({ estimate: undefined, estimating: false, estimateError: undefined });
      return;
    }
    this.update({ estimating: true, estimateError: undefined });
    try {
      const estimate = await this.services.estimate(request);
      if (version !== this.estimateVersion) return;
      if (
        !sameEstimate(estimate, request) ||
        typeof estimate.buy_amount !== "bigint" ||
        estimate.buy_amount <= 0n ||
        !Number.isSafeInteger(estimate.expires_at) ||
        estimate.expires_at <= Date.now()
      )
        throw new Error("Invalid swap estimate");
      this.update({ estimate: Object.freeze({ ...estimate }) });
    } catch {
      if (version === this.estimateVersion)
        this.update({ estimate: undefined, estimateError: "Quote unavailable. Try again." });
    } finally {
      if (version === this.estimateVersion) this.update({ estimating: false });
    }
  };
  private async readQuote(wallet: WalletIdentity) {
    this.estimateVersion++;
    this.update({ estimating: false, estimateError: undefined });
    const request = this.request(wallet);
    const quote = await this.provider().quote(request);
    if (
      !sameRequest(quote, request) ||
      !quote.id ||
      typeof quote.buy_amount !== "bigint" ||
      quote.buy_amount <= 0n ||
      typeof quote.minimum_received !== "bigint" ||
      quote.minimum_received <= 0n ||
      quote.minimum_received > quote.buy_amount ||
      quote.minimum_received * 10_000n < quote.buy_amount * BigInt(10_000 - request.slippage_bps) ||
      !Number.isSafeInteger(quote.expires_at) ||
      quote.expires_at <= Date.now() ||
      typeof quote.network_fee?.amount !== "bigint" ||
      quote.network_fee.amount < 0n ||
      !quote.network_fee.symbol ||
      !Number.isInteger(quote.network_fee.decimals) ||
      quote.network_fee.decimals < 0 ||
      quote.network_fee.decimals > 77
    )
      throw new Error("Unable to verify this swap quote.");
    this.update({
      quote: Object.freeze({
        ...quote,
        recipient: Object.freeze({ ...quote.recipient }),
        network_fee: Object.freeze({ ...quote.network_fee }),
      }),
      receipt: undefined,
    });
  }
  review = () =>
    this.run(async () => {
      if (this.snapshot.transactionId) throw new Error("Check your pending swap first.");
      this.update({ quote: undefined });
      await this.readQuote(await this.readWallet());
    });
  private async confirmReceipt() {
    const { quote, transactionId } = this.snapshot;
    if (!quote || !transactionId) throw new Error("Swap transaction is missing.");
    const receipt = await this.provider().receipt(transactionId, quote);
    if (
      receipt.confirmed !== true ||
      receipt.transaction_id !== transactionId ||
      !sameRequest(receipt.request, quote) ||
      typeof receipt.buy_amount !== "bigint" ||
      receipt.buy_amount < quote.minimum_received
    )
      throw new Error("Swap confirmation is pending.");
    this.update({ receipt });
    // Execution changed the spendable balance. A receipt alone does not update it.
    await this.readWallet();
  }
  confirm = () =>
    this.run(async () => {
      if (this.snapshot.transactionId) {
        await this.confirmReceipt();
        return;
      }
      const quote = this.snapshot.quote;
      if (!quote) throw new Error("Review a quote first.");
      const wallet = await this.readWallet();
      if (!sameRequest(quote, this.request(wallet))) {
        this.update({ quote: undefined });
        throw new Error("Wallet changed. Review a fresh quote.");
      }
      if (quote.expires_at <= Date.now()) {
        this.update({ quote: undefined });
        throw new Error("Quote expired. Review a fresh quote.");
      }
      if (this.snapshot.balance! < quote.sell_amount)
        throw new Error(`Insufficient ${this.asset(quote.sell_asset).symbol}.`);
      try {
        const transactionId = await this.provider().execute(quote);
        if (!transactionId) throw new Error("Swap transaction is missing.");
        this.update({ transactionId });
      } catch (error) {
        if (!(error instanceof SwapPendingError) || !error.transactionId) throw error;
        this.update({ transactionId: error.transactionId });
      }
      await this.confirmReceipt();
    });
  /** Refresh the app only. Loan confirmation never broadcasts the swap. */
  afterFunding = async (result: FundingResult) => {
    const wallet = await this.readWallet();
    const asset = this.asset(this.snapshot.sell);
    if (
      !sameAddress(wallet.address, result.funding.recipient.address) ||
      wallet.account_id !== result.funding.recipient.account_id
    )
      throw new Error("Reconnect the wallet that received your loan.");
    if (!asset.token || !sameAddress(asset.token, result.funding.token))
      throw new Error("Select the token that received your loan before refreshing the swap.");
    if (this.snapshot.amount && !this.snapshot.transactionId && !this.snapshot.receipt)
      await this.readQuote(wallet);
  };
  shortfall(): string | undefined {
    const asset = this.token(this.snapshot.sell);
    if (!asset || this.snapshot.balance === undefined || this.snapshot.transactionId)
      return undefined;
    try {
      const missing = parseAmount(this.snapshot.amount, asset.decimals) - this.snapshot.balance;
      return missing > 0n ? formatUnits(missing, asset.decimals) : undefined;
    } catch {
      return undefined;
    }
  }
  reset = () => {
    if (!this.snapshot.busy && this.snapshot.receipt) {
      this.estimateVersion++;
      this.services?.clearCheckpoint?.();
      this.update({
        amount: "",
        quote: undefined,
        transactionId: undefined,
        receipt: undefined,
        balance: undefined,
        error: undefined,
        estimate: undefined,
        estimating: false,
        estimateError: undefined,
      });
      this.saveDraft();
    }
  };
  balanceLabel() {
    const asset = this.token(this.snapshot.sell);
    return asset && this.snapshot.balance !== undefined
      ? formatAmount(this.snapshot.balance, asset.decimals)
      : undefined;
  }
}
