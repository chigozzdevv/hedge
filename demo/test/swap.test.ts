import { describe, expect, it, vi } from "vitest";
import { SwapController, parseAmount } from "../src/swap/swap-controller";
import {
  SwapPendingError,
  type SwapServices,
  type SwapEstimate,
  type SwapEstimateRequest,
} from "../src/swap/swap-types";

const address = `0x${"1".repeat(40)}`;
const wallet = { chain_id: 296, address, account_id: "0.0.456" };
const assets = [
  { id: "usdc", symbol: "USDC", decimals: 6, chain_id: 296, token: address },
  { id: "hbar", symbol: "HBAR", decimals: 8, chain_id: 296 },
];
function fixture() {
  const services: SwapServices = {
    assets,
    wallet: vi.fn(async () => wallet),
    connect: vi.fn(async () => wallet),
    balance: vi.fn(async () => 1_000_000_000n),
    estimate: vi.fn(async (request) => ({
      ...request,
      buy_amount: request.sell_amount * 20n,
      expires_at: Date.now() + 60_000,
    })),
    quote: vi.fn(async (request) => ({
      ...request,
      id: "test-quote",
      buy_amount: 20_000_000_000n,
      minimum_received: 19_900_000_000n,
      expires_at: Date.now() + 60_000,
      network_fee: { amount: 1_000_000n, symbol: "HBAR", decimals: 8 },
    })),
    execute: vi.fn(async () => "test-only-swap"),
    receipt: vi.fn(async (transaction_id, quote) => ({
      transaction_id,
      confirmed: true as const,
      request: quote,
      buy_amount: quote.buy_amount,
    })),
  };
  const controller = new SwapController(services);
  controller.setAmount("1000");
  return { controller, services };
}
describe("reference swap flow", () => {
  it("prices an amount without connecting a wallet or preparing a transaction", async () => {
    const { controller, services } = fixture();
    vi.mocked(services.wallet).mockResolvedValue(null);
    await controller.preview();
    expect(controller.getSnapshot()).toMatchObject({
      estimate: { sell_amount: 1_000_000_000n, buy_amount: 20_000_000_000n },
      estimating: false,
      busy: false,
    });
    expect(controller.getSnapshot().quote).toBeUndefined();
    expect(services.wallet).not.toHaveBeenCalled();
    expect(services.connect).not.toHaveBeenCalled();
    expect(services.quote).not.toHaveBeenCalled();
    expect(services.execute).not.toHaveBeenCalled();
  });
  it("keeps the newest amount when DEX responses arrive out of order", async () => {
    const { controller, services } = fixture();
    const pending: { request: SwapEstimateRequest; resolve: (value: SwapEstimate) => void }[] = [];
    vi.mocked(services.estimate!).mockImplementation(
      (request) => new Promise((resolve) => pending.push({ request, resolve })),
    );
    const first = controller.preview();
    controller.setAmount("2");
    const second = controller.preview();
    pending[1].resolve({
      ...pending[1].request,
      buy_amount: 40_000_000n,
      expires_at: Date.now() + 60_000,
    });
    await second;
    pending[0].resolve({
      ...pending[0].request,
      buy_amount: 20_000_000_000n,
      expires_at: Date.now() + 60_000,
    });
    await first;
    expect(controller.getSnapshot().estimate).toMatchObject({
      sell_amount: 2_000_000n,
      buy_amount: 40_000_000n,
    });
    expect(controller.getSnapshot().estimating).toBe(false);
  });
  it("clears the estimate for empty, zero or invalid amounts without querying the DEX", async () => {
    const { controller, services } = fixture();
    await controller.preview();
    vi.mocked(services.estimate!).mockClear();
    for (const amount of ["", "0", "1e3", "0.1234567"]) {
      controller.setAmount(amount);
      await controller.preview();
      expect(controller.getSnapshot().estimate).toBeUndefined();
      expect(controller.getSnapshot().estimateError).toBeUndefined();
    }
    expect(services.estimate).not.toHaveBeenCalled();
  });
  it.each([
    { name: "another network", chain_id: 84532 },
    { name: "zero output", buy_amount: 0n },
    { name: "expired price", expires_at: 0 },
  ])("rejects a DEX estimate with $name", async (invalid) => {
    const { controller, services } = fixture();
    vi.mocked(services.estimate!).mockImplementation(async (request) => ({
      ...request,
      buy_amount: 20_000_000_000n,
      expires_at: Date.now() + 60_000,
      ...invalid,
    }));
    await controller.preview();
    expect(controller.getSnapshot().estimate).toBeUndefined();
    expect(controller.getSnapshot().estimateError).toContain("Quote unavailable");
    expect(services.execute).not.toHaveBeenCalled();
  });
  it("requires a reviewed wallet-bound quote even after showing a price estimate", async () => {
    const { controller, services } = fixture();
    await controller.preview();
    await controller.confirm();
    expect(controller.getSnapshot().error).toContain("Review a quote first");
    expect(services.execute).not.toHaveBeenCalled();
    await controller.review();
    await controller.confirm();
    expect(services.execute).toHaveBeenCalledTimes(1);
  });
  it("restores a draft without authorizing a quote or swap and blocks unsupported reverse routes", async () => {
    const { services } = fixture();
    Object.assign(services, { routes: [{ sell: "usdc", buy: "hbar" }] });
    services.loadDraft = () => ({ amount: "0.1", sell: "usdc", buy: "hbar" });
    services.saveDraft = vi.fn();
    const controller = new SwapController(services);
    await controller.initialize();
    expect(controller.getSnapshot()).toMatchObject({
      amount: "0.1",
      sell: "usdc",
      buy: "hbar",
    });
    expect(controller.getSnapshot().quote).toBeUndefined();
    controller.reverse();
    expect(controller.getSnapshot().sell).toBe("usdc");
    expect(services.execute).not.toHaveBeenCalled();
    controller.setAmount("0.2");
    expect(services.saveDraft).toHaveBeenCalledWith({ amount: "0.2", sell: "usdc", buy: "hbar" });
  });
  it("refreshes the spendable balance after successful swap execution", async () => {
    const { controller, services } = fixture();
    await controller.review();
    vi.mocked(services.balance).mockResolvedValueOnce(1_000_000_000n).mockResolvedValue(0n);
    await controller.confirm();
    expect(controller.getSnapshot().receipt?.confirmed).toBe(true);
    expect(controller.getSnapshot().balance).toBe(0n);
    expect(services.execute).toHaveBeenCalledTimes(1);
  });
  it("preserves token precision and rejects excess precision and exponent notation", () => {
    expect(parseAmount("9007199254740993.000001", 6)).toBe(9007199254740993000001n);
    expect(() => parseAmount("1.0000001", 6)).toThrow("decimal places");
    expect(() => parseAmount("1e3", 6)).toThrow();
    expect(() => parseAmount("0", 6)).toThrow();
  });
  it("has no mock wallet, quote or transaction when unconfigured", async () => {
    const controller = new SwapController();
    controller.setAmount("1000");
    await controller.connect();
    expect(controller.getSnapshot().error).toBe("Wallet connection is unavailable.");
    expect(controller.getSnapshot().wallet).toBeUndefined();
    expect(controller.getSnapshot().quote).toBeUndefined();
    expect(controller.getSnapshot().receipt).toBeUndefined();
  });
  it("reviews without executing; editing and reversing invalidate the quote", async () => {
    const { controller, services } = fixture();
    await controller.review();
    expect(services.execute).not.toHaveBeenCalled();
    controller.setAmount("500");
    expect(controller.getSnapshot().quote).toBeUndefined();
    await controller.review();
    controller.reverse();
    expect(controller.getSnapshot()).toMatchObject({
      sell: "hbar",
      buy: "usdc",
      quote: undefined,
      balance: undefined,
    });
  });
  it("rejects quotes for another wallet or a looser minimum output", async () => {
    const { controller, services } = fixture();
    const valid = await services.quote({
      chain_id: 296,
      sell_asset: "usdc",
      buy_asset: "hbar",
      sell_amount: 1_000_000_000n,
      recipient: wallet,
      slippage_bps: 50,
    });
    vi.mocked(services.quote).mockResolvedValue({
      ...valid,
      recipient: { ...wallet, account_id: "0.0.789" },
    });
    await controller.review();
    expect(controller.getSnapshot().quote).toBeUndefined();
    vi.mocked(services.quote).mockResolvedValue({ ...valid, minimum_received: 19_000_000_000n });
    await controller.review();
    expect(controller.getSnapshot().error).toContain("verify");
    expect(services.execute).not.toHaveBeenCalled();
  });
  it("rereads wallet and balance before separate swap confirmation", async () => {
    const { controller, services } = fixture();
    await controller.review();
    vi.mocked(services.wallet).mockResolvedValue({ ...wallet, address: `0x${"3".repeat(40)}` });
    await controller.confirm();
    expect(controller.getSnapshot().error).toContain("Wallet changed");
    expect(services.execute).not.toHaveBeenCalled();
    vi.mocked(services.wallet).mockResolvedValue(wallet);
    await controller.review();
    vi.mocked(services.balance).mockResolvedValue(0n);
    await controller.confirm();
    expect(controller.getSnapshot().error).toBe("Insufficient USDC.");
    expect(services.execute).not.toHaveBeenCalled();
  });
  it("rejects an expired quote before signing", async () => {
    const { controller, services } = fixture();
    await controller.review();
    const expiry = controller.getSnapshot().quote!.expires_at;
    const now = vi.spyOn(Date, "now").mockReturnValue(expiry);
    try {
      await controller.confirm();
      expect(controller.getSnapshot().error).toContain("expired");
      expect(services.execute).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });
  it("keeps submission separate from success and checks a pending swap without rebroadcast", async () => {
    const { controller, services } = fixture();
    await controller.review();
    vi.mocked(services.receipt).mockRejectedValueOnce(new Error("Confirmation unavailable."));
    await controller.confirm();
    expect(controller.getSnapshot()).toMatchObject({
      transactionId: "test-only-swap",
      receipt: undefined,
    });
    const quote = controller.getSnapshot().quote;
    controller.setAmount("2000");
    await controller.review();
    await controller.connect();
    expect(controller.getSnapshot().quote).toBe(quote);
    await controller.confirm();
    expect(services.execute).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().receipt?.confirmed).toBe(true);
  });
  it("retains a broadcast ID surfaced by the provider after a partial failure", async () => {
    const { controller, services } = fixture();
    await controller.review();
    vi.mocked(services.execute).mockRejectedValue(new SwapPendingError("already-submitted"));
    vi.mocked(services.receipt).mockRejectedValueOnce(new Error("Still pending."));
    await controller.confirm();
    await controller.confirm();
    expect(services.execute).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().receipt?.transaction_id).toBe("already-submitted");
  });
  it("does not accept a receipt for another request or below the quoted minimum", async () => {
    const { controller, services } = fixture();
    await controller.review();
    vi.mocked(services.receipt).mockImplementation(async (transaction_id, quote) => ({
      transaction_id,
      confirmed: true,
      request: { ...quote, sell_amount: 2n },
      buy_amount: quote.buy_amount,
    }));
    await controller.confirm();
    expect(controller.getSnapshot().receipt).toBeUndefined();
    vi.mocked(services.receipt).mockImplementation(async (transaction_id, quote) => ({
      transaction_id,
      confirmed: true,
      request: quote,
      buy_amount: quote.minimum_received - 1n,
    }));
    await controller.confirm();
    expect(controller.getSnapshot().receipt).toBeUndefined();
    expect(services.execute).toHaveBeenCalledTimes(1);
  });
  it("refreshes balance and quote after funding, then requires a separate swap confirmation", async () => {
    const { controller, services } = fixture();
    vi.mocked(services.balance).mockResolvedValue(200_000_000n);
    await controller.review();
    expect(controller.shortfall()).toBe("800");
    vi.mocked(services.balance).mockResolvedValue(1_000_000_000n);
    await controller.afterFunding({
      instance_id: "fixture",
      credit_id: "loan-1",
      offer_id: "offer-1",
      agreement_hash: `0x${"2".repeat(64)}`,
      funding: { token: address, amount: 800_000_000n, recipient: wallet },
      transaction: { chain: "hedera", hash: "fixture-payout", confirmed: true },
    });
    expect(controller.shortfall()).toBeUndefined();
    expect(controller.getSnapshot().quote).toBeDefined();
    expect(services.execute).not.toHaveBeenCalled();
    await controller.confirm();
    expect(services.execute).toHaveBeenCalledTimes(1);
  });
});
