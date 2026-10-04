import { describe, expect, it, vi } from "vitest";
import {
  create_hedge,
  EvmHedgeAdapter,
  EvmHedgeReader,
  HedgeError,
  PendingError,
  type CreditSummary,
  type DeploymentManifest,
  type FundingResult,
  type HedgeAdapter,
  type Offer,
  type Chain,
  type WalletIdentity,
} from "@hedge/sdk";
import { createHedgeModal, HedgeModalController } from "../src/modal/modal-controller";
import { formatAmount } from "../src/modal/format-amount";
import type { ModalServices } from "../src/modal/modal-types";

const address = `0x${"1".repeat(40)}`,
  baseAddress = `0x${"3".repeat(40)}`,
  hash = `0x${"2".repeat(64)}` as const;
const network = { router: address, selector: "1", contract: address, code_hash: hash };
const manifest: DeploymentManifest = {
  schema_version: 1,
  instance_id: "fixture",
  build_id: "test",
  protocol_version: 3,
  deployer: address,
  hedera: { ...network, chain_id: 296, contract_id: "0.0.123" },
  base: { ...network, chain_id: 84532, selector: "2" },
};
const funding = {
  token: address,
  amount: 1_000_000_000n,
  recipient: { address, account_id: "0.0.456" },
};
const offer: Offer = {
  id: "offer-1",
  instance_id: "fixture",
  terms_hash: hash,
  operator: address,
  funding,
  repayment_amount: 1_020_000_000n,
  acceptance_deadline: 2_000_000_000,
  setup_deadline: 2_000_001_000,
  duration: 30 * 86400,
  grace_period: 0,
  collateral: {
    asset: baseAddress,
    amount: 2_500_000_000n,
    owner: baseAddress,
    return_recipient: baseAddress,
    recovery_recipient: baseAddress,
  },
};
const receipt: FundingResult = {
  instance_id: "fixture",
  credit_id: "loan-1",
  offer_id: offer.id,
  agreement_hash: hash,
  funding,
  transaction: { chain: "hedera", hash: "test-only-payout", confirmed: true },
};
const funded: CreditSummary = {
  instance_id: "fixture",
  credit_id: "loan-1",
  agreement_hash: hash,
  state: "funded",
  collateral_state: "locked",
  amount_due: offer.repayment_amount,
  payment_deadline: 2_000_003_000,
};

function fixture() {
  let summary = { ...funded };
  let payout: FundingResult | null = receipt;
  const wallets: Partial<Record<Chain, WalletIdentity>> = {};
  const unavailable = async (): Promise<never> => {
    throw new Error("Unconfigured test operation");
  };
  const accept = vi.fn<HedgeAdapter["accept"]>(async (_request, options) => {
    options.on_progress?.({ instance_id: "fixture", credit_id: "loan-1", stage: "accepted" });
    return receipt;
  });
  const repay = vi.fn<HedgeAdapter["repay"]>(async () => {
    summary = { ...summary, state: "repaid", amount_due: 0n, collateral_state: "return_pending" };
    return receipt.transaction;
  });
  const claim = vi.fn<HedgeAdapter["claimCollateral"]>(async () => {
    summary = { ...summary, collateral_state: "returned" };
    return { chain: "base", hash: "test-only-return", confirmed: true };
  });
  const adapter: HedgeAdapter = {
    verifyDeployment: async () => {},
    offers: vi.fn(async () => [offer]),
    accept,
    summary: async () => summary,
    funding: async () => payout,
    resume: vi.fn(async () => summary),
    cancel: unavailable,
    repay,
    activity: async () => [],
    subscribe: () => () => {},
    collateralStatus: async () => ({ state: summary.collateral_state }),
    claimCollateral: claim,
    operatorSummary: unavailable,
    deposit: unavailable,
    withdraw: unavailable,
    operatorOffers: unavailable,
    offer: unavailable,
    publishOffer: unavailable,
    withdrawOffer: unavailable,
    authorizeDefault: unavailable,
    claimRecovery: unavailable,
  };
  const services: ModalServices = {
    loanToken: async () => ({ chain_id: 296, address, symbol: "USDC", decimals: 6 }),
    wallet: async (chain) => wallets[chain] ?? null,
    connect: async (chain) =>
      (wallets[chain] = {
        chain_id: manifest[chain].chain_id,
        address: chain === "base" ? baseAddress : address,
        ...(chain === "hedera" ? { account_id: funding.recipient.account_id } : {}),
      }),
    token: async (chain, asset) => ({
      chain_id: manifest[chain].chain_id,
      address: asset,
      symbol: "USDC",
      decimals: 6,
    }),
    agreement: async (id) => ({
      instance_id: "fixture",
      credit_id: id,
      agreement_hash: hash,
      offer,
    }),
  };
  const modal = new HedgeModalController(services);
  adapter.loanToken = services.loanToken;
  const client = create_hedge({ manifest, adapter, modal: modal.renderer });
  async function open(
    request: { funding: typeof funding } | { credit_id: string } | { amount: string } = { funding },
  ) {
    const onFunded = vi.fn();
    const promise = client.open({
      ...request,
      context: { title: "Borrow to swap", continueLabel: "Continue to swap" },
      onFunded,
    });
    await vi.waitFor(() =>
      expect(modal.getSnapshot().open && !modal.getSnapshot().busy).toBe(true),
    );
    return { promise, onFunded };
  }
  async function review() {
    await modal.connect("base");
    await modal.connect("hedera");
    await modal.review();
  }
  return {
    modal,
    client,
    adapter,
    services,
    wallets,
    accept,
    repay,
    claim,
    open,
    review,
    setSummary: (value: CreditSummary) => {
      summary = value;
    },
    setPayout: (value: FundingResult | null) => {
      payout = value;
    },
  };
}
describe("Use Hedge modal chain boundaries", () => {
  it("recovers confirmed acceptance and locking receipts when reopening without a browser transaction journal", async () => {
    const f = fixture();
    const accept = {
      chain: "hedera" as const,
      hash: `0x${"a".repeat(64)}`,
      confirmed: true as const,
    };
    const collateral = {
      chain: "base" as const,
      hash: `0x${"b".repeat(64)}`,
      confirmed: true as const,
    };
    f.adapter.activity = vi.fn(async () => [
      { stage: "LoanAccepted", transaction: accept },
      { stage: "CollateralLocked", transaction: collateral },
      {
        stage: "CollateralLocked",
        transaction: { ...collateral, chain: "hedera" as const, hash: `0x${"c".repeat(64)}` },
      },
    ]);
    const selection = await f.open({ credit_id: "loan-1" });
    await vi.waitFor(() =>
      expect(f.modal.getSnapshot().transactions).toEqual({ accept, collateral }),
    );
    expect(f.modal.getSnapshot().funding?.transaction).toEqual(receipt.transaction);
    expect(f.accept).not.toHaveBeenCalled();
    f.modal.close();
    await selection.promise;
  });
  it("keeps loan state available while optional receipt history is pending or unavailable", async () => {
    const f = fixture();
    let fail: ((error: Error) => void) | undefined;
    f.adapter.activity = vi.fn<HedgeAdapter["activity"]>(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    const selection = await f.open({ credit_id: "loan-1" });
    expect(f.modal.getSnapshot().funding).toEqual(receipt);
    expect(f.modal.getSnapshot().busy).toBe(false);
    await f.modal.refresh();
    expect(f.adapter.activity).toHaveBeenCalledTimes(1);
    fail!(new Error("History unavailable"));
    await vi.waitFor(() => expect(f.modal.getSnapshot().error).toBeUndefined());
    expect(f.modal.getSnapshot().funding).toEqual(receipt);
    f.modal.close();
    await selection.promise;
  });
  it("resolves decimal amounts and the actual connected recipient inside the same modal", async () => {
    const f = fixture();
    const selection = await f.open({ amount: "1000" });
    expect(f.adapter.offers).not.toHaveBeenCalled();
    await f.modal.review();
    expect(f.modal.getSnapshot().error).toContain("Connect both wallets");
    await f.review();
    expect(f.adapter.offers).toHaveBeenCalledWith({ funding });
    expect(f.modal.getSnapshot().loanToken?.symbol).toBe("USDC");
    await f.modal.accept();
    expect(selection.onFunded).not.toHaveBeenCalled();
    await f.modal.continueToApp();
    await expect(selection.promise).resolves.toEqual(receipt);
    expect(selection.onFunded).toHaveBeenCalledOnce();
  });
  it("recovers an outstanding loan before publishing an offer after cleared storage", async () => {
    const f = fixture();
    f.services.outstandingLoans = async () => ["loan-1"];
    const selection = await f.open({ amount: "1000" });
    await f.review();
    expect(f.modal.getSnapshot().creditId).toBe("loan-1");
    expect(f.adapter.offers).not.toHaveBeenCalled();
    expect(f.accept).not.toHaveBeenCalled();
    f.modal.close();
    await expect(selection.promise).resolves.toBeNull();
  });
  it("requires explicit selection when several outstanding loans are found", async () => {
    const f = fixture();
    f.services.outstandingLoans = async () => ["loan-1", "loan-2"];
    const selection = await f.open({ amount: "1000" });
    await f.review();
    expect(f.modal.getSnapshot().error).toContain("Several loans need attention");
    expect(f.adapter.offers).not.toHaveBeenCalled();
    f.modal.close();
    await selection.promise;
  });
  it("shares the adapter's wallets, accepted terms and checkpoint journal through funding", async () => {
    const f = fixture();
    const reader = new EvmHedgeReader({
      manifest,
      rpc: { hedera: "http://fixture.invalid", base: "http://fixture.invalid" },
      startBlock: { hedera: 0n, base: 0n },
      resolveAccount: async () => funding.recipient.account_id,
    });
    vi.spyOn(reader, "token").mockImplementation(f.services.token);
    vi.spyOn(reader, "agreement").mockImplementation(async (id) => ({
      ...(await f.services.agreement(id)),
      agreement_hash: hash,
    }));
    const checkpoint = vi.fn();
    const adapter = new EvmHedgeAdapter({
      reader,
      operator: address,
      wallet: { connect: f.services.connect, wallet: f.services.wallet, send: vi.fn() },
      journal: { get: () => undefined, set: vi.fn(), checkpoint },
      discover: async () => [],
      relay: async () => {},
    });
    vi.spyOn(adapter, "verifyDeployment").mockResolvedValue();
    vi.spyOn(adapter, "offers").mockImplementation(f.adapter.offers);
    vi.spyOn(adapter, "accept").mockImplementation(f.adapter.accept);
    vi.spyOn(adapter, "summary").mockImplementation(f.adapter.summary);
    vi.spyOn(adapter, "funding").mockImplementation(f.adapter.funding);
    vi.spyOn(adapter, "activity").mockResolvedValue([]);
    const modal = createHedgeModal(adapter);
    const client = create_hedge({ manifest, adapter, modal: modal.renderer });
    const opening = client.open({ funding });
    await vi.waitFor(() =>
      expect(modal.getSnapshot().open && !modal.getSnapshot().busy).toBe(true),
    );
    await modal.connect("base");
    await modal.connect("hedera");
    expect(f.wallets.base?.address).toBe(baseAddress);
    expect(f.wallets.hedera?.account_id).toBe(funding.recipient.account_id);
    await modal.review();
    await modal.accept();
    expect(modal.getSnapshot().screen).toBe("funded");
    expect(checkpoint).toHaveBeenCalledWith(expect.objectContaining({ credit_id: "loan-1" }));
    await modal.continueToApp();
    await expect(opening).resolves.toEqual(receipt);
    expect(f.accept).toHaveBeenCalledTimes(1);
  });
  it("allows a new funding request only after canonical repayment and collateral return", async () => {
    const f = fixture();
    f.modal.remember({ instance_id: "fixture", credit_id: "loan-1" });
    f.setSummary({ ...funded, state: "repaid", amount_due: 0n, collateral_state: "returned" });
    const opening = await f.open({ funding: { ...funding, amount: 1n } });
    expect(f.modal.getSnapshot().creditId).toBeUndefined();
    expect(f.accept).not.toHaveBeenCalled();
    f.modal.close();
    await expect(opening.promise).resolves.toBeNull();
  });
  it("gates review on both wallets and hands off only after rereading confirmed funding", async () => {
    const f = fixture(),
      opening = await f.open();
    await f.modal.review();
    expect(f.modal.getSnapshot().error).toMatch(/both wallets/);
    expect(f.adapter.offers).not.toHaveBeenCalled();
    await f.review();
    await f.modal.accept();
    expect(f.modal.getSnapshot().screen).toBe("funded");
    expect(opening.onFunded).not.toHaveBeenCalled();
    await f.modal.continueToApp();
    await expect(opening.promise).resolves.toEqual(receipt);
    expect(opening.onFunded).toHaveBeenCalledWith(receipt);
  });
  it("does not label a missing payout receipt funded or call the app continuation", async () => {
    const f = fixture();
    f.setPayout(null);
    const opening = await f.open({ credit_id: "loan-1" });
    expect(f.modal.getSnapshot().screen).not.toBe("funded");
    await f.modal.continueToApp();
    expect(f.modal.getSnapshot().error).toMatch(/confirmed loan funding/);
    f.modal.close();
    await expect(opening.promise).resolves.toBeNull();
    expect(opening.onFunded).not.toHaveBeenCalled();
  });
  it("requires the funded recipient wallet again if the account changes before Continue", async () => {
    const f = fixture();
    const opening = await f.open({ amount: "1000" });
    await f.review();
    await f.modal.accept();
    f.wallets.hedera = { chain_id: 296, address: baseAddress, account_id: "0.0.999" };
    await f.modal.continueToApp();
    expect(f.modal.getSnapshot().error).toContain("borrower wallet");
    expect(opening.onFunded).not.toHaveBeenCalled();
    f.modal.close();
    await expect(opening.promise).resolves.toBeNull();
  });
  it("keeps pending acceptance checkpoints and resumes without accepting another loan", async () => {
    const f = fixture();
    f.setSummary({ ...funded, state: "accepted", amount_due: 0n, payment_deadline: null });
    f.setPayout(null);
    f.accept.mockImplementation(async () => {
      throw new PendingError("Awaiting CCIP", {
        instance_id: "fixture",
        credit_id: "loan-1",
        stage: "agreement_pending",
      });
    });
    const first = await f.open();
    await f.review();
    await f.modal.accept();
    expect(f.modal.getSnapshot().creditId).toBe("loan-1");
    expect(f.modal.getSnapshot().error).toBeUndefined();
    f.modal.close();
    await first.promise;
    const second = await f.open();
    await f.modal.resume();
    expect(f.accept).toHaveBeenCalledTimes(1);
    expect(f.adapter.resume).toHaveBeenCalledTimes(1);
    f.modal.close();
    await second.promise;
  });
  it.each(["custody_pending", "funding_pending"])(
    "keeps %s as progress and observes funding without another acceptance",
    async (stage) => {
      const f = fixture();
      f.setSummary({ ...funded, state: "accepted", amount_due: 0n, payment_deadline: null });
      f.setPayout(null);
      f.accept.mockImplementation(async () => {
        throw new PendingError("Payout is still pending", {
          instance_id: "fixture",
          credit_id: "loan-1",
          stage,
        });
      });
      const opening = await f.open();
      await f.review();
      await f.modal.accept();
      await f.modal.refresh();
      expect(f.modal.getSnapshot()).toMatchObject({ screen: "setup", busy: false });
      expect(f.modal.getSnapshot().error).toBeUndefined();
      expect(f.modal.getSnapshot().funding).toBeUndefined();
      expect(opening.onFunded).not.toHaveBeenCalled();
      f.setSummary(funded);
      f.setPayout(receipt);
      await f.modal.refresh();
      expect(f.modal.getSnapshot().screen).toBe("funded");
      await f.modal.continueToApp();
      await expect(opening.promise).resolves.toEqual(receipt);
      expect(f.accept).toHaveBeenCalledTimes(1);
      expect(f.adapter.resume).not.toHaveBeenCalled();
    },
  );
  it("waits for an indexed payout receipt without an error or app handoff", async () => {
    const f = fixture();
    const fundingRead = vi.fn<HedgeAdapter["funding"]>(async () => {
      throw new HedgeError("FUNDING_PENDING", "The confirmed payout receipt is not available yet");
    });
    f.adapter.funding = fundingRead;
    const opening = await f.open({ credit_id: "loan-1" });
    await f.modal.refresh();
    expect(f.modal.getSnapshot().screen).toBe("setup");
    expect(f.modal.getSnapshot().error).toBeUndefined();
    expect(f.modal.getSnapshot().funding).toBeUndefined();
    expect(opening.onFunded).not.toHaveBeenCalled();
    fundingRead.mockResolvedValue(receipt);
    await f.modal.refresh();
    expect(f.modal.getSnapshot().screen).toBe("funded");
    await f.modal.continueToApp();
    await expect(opening.promise).resolves.toEqual(receipt);
  });
  it("keeps the funding screen when acceptance completes before payout indexing", async () => {
    const f = fixture();
    f.setPayout(null);
    f.accept.mockImplementation(async (_request, options) => {
      options.on_progress?.({ instance_id: "fixture", credit_id: "loan-1", stage: "funded" });
      throw new PendingError("The confirmed payout receipt is not available yet", {
        instance_id: "fixture",
        credit_id: "loan-1",
        stage: "funding_pending",
      });
    });
    const opening = await f.open();
    await f.review();
    await f.modal.accept();
    await f.modal.refresh();
    expect(f.modal.getSnapshot()).toMatchObject({ screen: "setup", summary: { state: "funded" } });
    expect(f.modal.getSnapshot().error).toBeUndefined();
    expect(f.modal.getSnapshot().funding).toBeUndefined();
    expect(opening.onFunded).not.toHaveBeenCalled();
    f.setPayout(receipt);
    await f.modal.refresh();
    await f.modal.continueToApp();
    await expect(opening.promise).resolves.toEqual(receipt);
  });
  it("still reports an invalid pending checkpoint and a mismatched payout", async () => {
    const f = fixture();
    f.accept.mockImplementation(async () => {
      throw new PendingError("Pending", {
        instance_id: "another-instance",
        credit_id: "loan-1",
        stage: "funding_pending",
      });
    });
    const opening = await f.open();
    await f.review();
    await f.modal.accept();
    expect(f.modal.getSnapshot().error).toContain("another deployment");
    f.modal.close();
    await opening.promise;
    f.adapter.funding = async () => {
      throw new HedgeError("FUNDING_MISMATCH", "The payout does not match the accepted loan");
    };
    const recovery = await f.open({ credit_id: "loan-1" });
    expect(f.modal.getSnapshot().error).toContain("does not match");
    expect(f.modal.getSnapshot().funding).toBeUndefined();
    f.modal.close();
    await recovery.promise;
  });
  it("refreshes confirmed collateral during pending funding without enabling continuation", async () => {
    const f = fixture();
    f.setSummary({ ...funded, state: "accepted", amount_due: 0n, payment_deadline: null });
    f.setPayout(null);
    let complete: ((value: FundingResult) => void) | undefined;
    f.accept.mockImplementation(async (_request, options) => {
      options.on_progress?.({ instance_id: "fixture", credit_id: "loan-1", stage: "accepted" });
      return new Promise((resolve) => {
        complete = resolve;
      });
    });
    const opening = await f.open();
    await f.review();
    const accepting = f.modal.accept();
    await vi.waitFor(() => expect(complete).toBeDefined());
    await f.modal.refresh();
    expect(f.modal.getSnapshot().busy).toBe(true);
    expect(f.modal.getSnapshot().summary?.collateral_state).toBe("locked");
    expect(f.modal.getSnapshot().funding).toBeUndefined();
    expect(f.modal.getSnapshot().screen).toBe("setup");
    await f.modal.continueToApp();
    expect(opening.onFunded).not.toHaveBeenCalled();
    f.setSummary(funded);
    f.setPayout(receipt);
    complete!(receipt);
    await accepting;
    expect(f.modal.getSnapshot().screen).toBe("funded");
    await f.modal.continueToApp();
    await expect(opening.promise).resolves.toEqual(receipt);
  });
  it("keeps repayment and collateral release separate and blocks premature claims", async () => {
    const f = fixture(),
      opening = await f.open({ credit_id: "loan-1" });
    await f.modal.repay();
    expect(f.modal.getSnapshot().screen).toBe("return");
    expect(f.modal.getSnapshot().summary?.collateral_state).toBe("return_pending");
    await f.modal.claim();
    expect(f.claim).not.toHaveBeenCalled();
    f.setSummary({
      ...funded,
      state: "repaid",
      amount_due: 0n,
      collateral_state: "return_authorized",
    });
    await f.modal.refresh();
    await f.modal.claim();
    expect(f.modal.getSnapshot().screen).toBe("complete");
    f.modal.close();
    await opening.promise;
    expect(opening.onFunded).not.toHaveBeenCalled();
  });
  it("reviews collateral repayment and completes only on a canonical repaid outcome", async () => {
    const f = fixture();
    f.services.agreement = async (id) => ({
      instance_id: "fixture",
      credit_id: id,
      agreement_hash: hash,
      offer: { ...offer, collateral: { ...offer.collateral, repayment_amount: 1020000000n } },
    });
    f.adapter.repayWithCollateral = vi.fn<NonNullable<HedgeAdapter["repayWithCollateral"]>>(
      async (_id, reviewed) => {
        expect(reviewed).toBe(hash);
        f.setSummary({ ...funded, state: "settling", collateral_state: "settled" });
        return { ...funded, state: "settling", collateral_state: "settled" };
      },
    );
    const opening = await f.open({ credit_id: "loan-1" });
    f.modal.prepareRepayment();
    f.modal.selectRepaymentSource("collateral");
    await f.modal.repay();
    expect(f.repay).not.toHaveBeenCalled();
    expect(f.modal.getSnapshot().screen).toBe("settle");
    f.setSummary({ ...funded, state: "repaid", amount_due: 0n, collateral_state: "settled" });
    await f.modal.refresh();
    expect(f.modal.getSnapshot().screen).toBe("complete");
    expect(f.claim).not.toHaveBeenCalled();
    f.modal.close();
    await opening.promise;
  });
  it("rereads the signing wallet before repayment", async () => {
    const f = fixture(),
      opening = await f.open({ credit_id: "loan-1" });
    f.wallets.hedera = { chain_id: 296, address: baseAddress, account_id: "0.0.999" };
    await f.modal.repay();
    expect(f.repay).not.toHaveBeenCalled();
    expect(f.modal.getSnapshot().error).toMatch(/borrower wallet/);
    f.modal.close();
    await opening.promise;
  });
  it("orders a pending refresh before the post-funding read", async () => {
    const f = fixture();
    const pending = {
      ...funded,
      state: "accepted" as const,
      amount_due: 0n,
      payment_deadline: null,
    };
    f.setSummary(pending);
    f.setPayout(null);
    let finishAccept: ((value: FundingResult) => void) | undefined;
    f.accept.mockImplementation(async (_request, options) => {
      options.on_progress?.({ instance_id: "fixture", credit_id: "loan-1", stage: "accepted" });
      return new Promise((resolve) => {
        finishAccept = resolve;
      });
    });
    const opening = await f.open();
    await f.review();
    const accepting = f.modal.accept();
    await vi.waitFor(() => expect(finishAccept).toBeDefined());
    let finishRefresh: ((value: CreditSummary) => void) | undefined;
    const freshSummary = f.adapter.summary;
    f.adapter.summary = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishRefresh = resolve;
          }),
      )
      .mockImplementation(freshSummary);
    const refreshing = f.modal.refresh();
    await vi.waitFor(() => expect(finishRefresh).toBeDefined());
    f.setSummary(funded);
    f.setPayout(receipt);
    finishAccept!(receipt);
    finishRefresh!(pending);
    await Promise.all([refreshing, accepting]);
    expect(f.modal.getSnapshot().summary?.state).toBe("funded");
    expect(f.modal.getSnapshot().screen).toBe("funded");
    f.modal.close();
    await opening.promise;
  });
  it("rejects another agreement and incorrect token metadata", async () => {
    const f = fixture();
    f.services.agreement = async (id) => ({
      instance_id: "fixture",
      credit_id: id,
      agreement_hash: `0x${"9".repeat(64)}`,
      offer,
    });
    const opening = await f.open({ credit_id: "loan-1" });
    expect(f.modal.getSnapshot().error).toMatch(/accepted terms|Accepted terms/);
    expect(f.modal.getSnapshot().offer).toBeUndefined();
    f.modal.close();
    await opening.promise;
    const g = fixture();
    g.services.token = async (_chain, asset) => ({
      chain_id: 1,
      address: asset,
      symbol: "USDC",
      decimals: 6,
    });
    const other = await g.open();
    await g.review();
    expect(g.modal.getSnapshot().error).toMatch(/Token metadata/);
    expect(g.modal.getSnapshot().screen).toBe("connect");
    g.modal.close();
    await other.promise;
  });
  it("does not interrupt confirmed acceptance when local checkpoint storage fails", async () => {
    const f = fixture();
    f.services.onCheckpoint = () => {
      throw new Error("storage quota");
    };
    const opening = await f.open();
    await f.review();
    await f.modal.accept();
    expect(f.modal.getSnapshot().creditId).toBe("loan-1");
    expect(f.modal.getSnapshot().screen).toBe("funded");
    f.modal.close();
    await opening.promise;
  });
  it("preserves exact base-unit values without floating point rounding", () => {
    expect(formatAmount(1_020_000_000n, 6)).toBe("1,020");
    expect(formatAmount(123456789012345678901234567890n, 18)).toBe(
      "123,456,789,012.34567890123456789",
    );
    expect(formatAmount(1n, 18)).toBe("0.000000000000000001");
  });
  it("does not accept a changed offer after review", async () => {
    const f = fixture(),
      opening = await f.open();
    await f.review();
    f.adapter.offers = async () => [{ ...offer, terms_hash: `0x${"8".repeat(64)}` }];
    await f.modal.accept();
    expect(f.accept).not.toHaveBeenCalled();
    expect(f.modal.getSnapshot().screen).toBe("connect");
    expect(f.modal.getSnapshot().error).toMatch(/offer changed/);
    f.modal.close();
    await opening.promise;
  });
  it("keeps a submitted operation after dismissal and blocks a second acceptance", async () => {
    const f = fixture();
    let complete: ((value: FundingResult) => void) | undefined;
    f.accept.mockImplementation(async (_request, options) => {
      options.on_progress?.({ instance_id: "fixture", credit_id: "loan-1", stage: "accepted" });
      return new Promise((resolve) => {
        complete = resolve;
      });
    });
    const first = await f.open();
    await f.review();
    const accepting = f.modal.accept();
    await vi.waitFor(() => expect(complete).toBeDefined());
    f.modal.close();
    await expect(first.promise).resolves.toBeNull();
    await expect(f.client.open({ funding })).rejects.toMatchObject({ code: "MODAL_BUSY" });
    complete!(receipt);
    await accepting;
    expect(f.modal.getSnapshot().open).toBe(false);
    expect(first.onFunded).not.toHaveBeenCalled();
    const resumed = await f.open();
    expect(f.modal.getSnapshot().creditId).toBe("loan-1");
    expect(f.accept).toHaveBeenCalledTimes(1);
    f.modal.close();
    await resumed.promise;
  });
  it("allows the agreed Base return recipient to claim without a Hedera wallet", async () => {
    const f = fixture(),
      returnAddress = `0x${"4".repeat(40)}`;
    f.setSummary({
      ...funded,
      state: "repaid",
      amount_due: 0n,
      collateral_state: "return_authorized",
    });
    f.services.agreement = async (id) => ({
      instance_id: "fixture",
      credit_id: id,
      agreement_hash: hash,
      offer: { ...offer, collateral: { ...offer.collateral, return_recipient: returnAddress } },
    });
    f.wallets.base = { chain_id: 84532, address: returnAddress };
    const opening = await f.open({ credit_id: "loan-1" });
    expect(f.modal.getSnapshot().screen).toBe("return");
    await f.modal.claim();
    expect(f.claim).toHaveBeenCalledTimes(1);
    expect(f.wallets.hedera).toBeUndefined();
    f.modal.close();
    await opening.promise;
  });
});
