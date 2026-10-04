import { describe, expect, it, vi } from "vitest";
import {
  create_hedge,
  HedgeError,
  PendingError,
  type HedgeAdapter,
  type ModalRenderer,
} from "../src";
import type { DeploymentManifest, FundingResult, CreditSummary, Offer } from "@hedge/schema";

const address = `0x${"1".repeat(40)}`;
const hash = `0x${"2".repeat(64)}`;
const chain = { chain_id: 296, router: address, selector: "1", contract: address, code_hash: hash };
const manifest: DeploymentManifest = {
  schema_version: 1,
  instance_id: "fixture",
  build_id: "unit-test",
  protocol_version: 3,
  deployer: address,
  hedera: { ...chain, contract_id: "0.0.123" },
  base: { ...chain, chain_id: 84532, selector: "2" },
};
const funding = { token: address, amount: 1n, recipient: { address, account_id: "0.0.456" } };
const result: FundingResult = {
  instance_id: "fixture",
  credit_id: "loan-1",
  offer_id: "offer-1",
  agreement_hash: hash,
  funding,
  transaction: { chain: "hedera", hash: "confirmed-test-tx", confirmed: true },
};
const summary: CreditSummary = {
  instance_id: "fixture",
  credit_id: "loan-1",
  agreement_hash: hash,
  state: "funded",
  collateral_state: "locked",
  amount_due: 1n,
  payment_deadline: 123,
};
const offer: Offer = {
  id: "offer-1",
  instance_id: "fixture",
  terms_hash: hash,
  operator: address,
  funding,
  repayment_amount: 1n,
  acceptance_deadline: 100,
  setup_deadline: 200,
  duration: 300,
  grace_period: 0,
  collateral: {
    asset: address,
    amount: 1n,
    owner: address,
    return_recipient: address,
    recovery_recipient: address,
  },
};
function adapter(overrides: Partial<HedgeAdapter> = {}): HedgeAdapter {
  const unavailable = async (): Promise<never> => {
    throw new Error("Unconfigured test operation");
  };
  return {
    verifyDeployment: async () => {},
    offers: unavailable,
    accept: unavailable,
    summary: unavailable,
    funding: unavailable,
    resume: unavailable,
    cancel: unavailable,
    repay: unavailable,
    activity: unavailable,
    subscribe: () => {
      throw new Error("Unconfigured subscription");
    },
    collateralStatus: unavailable,
    claimCollateral: unavailable,
    operatorSummary: unavailable,
    deposit: unavailable,
    withdraw: unavailable,
    operatorOffers: unavailable,
    offer: unavailable,
    publishOffer: unavailable,
    withdrawOffer: unavailable,
    authorizeDefault: unavailable,
    claimRecovery: unavailable,
    ...overrides,
  };
}
describe("SDK deployment and loan boundaries", () => {
  it("validates an app amount resolved after connection and binds payout to that wallet", async () => {
    const identity = { chain_id: 296, ...funding.recipient };
    const calculate = vi.fn(async () => "0.000001");
    const modal: ModalRenderer = async (_client, request) => {
      expect(calculate).not.toHaveBeenCalled();
      if (typeof request.amount !== "function") throw new Error("Missing amount calculation");
      expect(await request.amount(identity)).toBe("0.000001");
      return { credit_id: "loan-1" };
    };
    const onFunded = vi.fn();
    const reader = adapter({
      loanToken: async () => ({ chain_id: 296, address, symbol: "USDC", decimals: 6 }),
      funding: async () => result,
    });
    const client = create_hedge({ manifest, modal, adapter: reader });
    await expect(client.open({ amount: calculate, onFunded })).resolves.toEqual(result);
    expect(calculate).toHaveBeenCalledWith(identity);
    expect(onFunded).toHaveBeenCalledExactlyOnceWith(result);
    reader.funding = async () => ({
      ...result,
      funding: { ...funding, recipient: { ...funding.recipient, address: `0x${"3".repeat(40)}` } },
    });
    calculate.mockClear();
    await expect(client.open({ amount: calculate, onFunded })).rejects.toMatchObject({
      code: "FUNDING_MISMATCH",
    });
    expect(onFunded).toHaveBeenCalledOnce();
  });
  it("rejects invalid deferred amounts before the modal can request an offer", async () => {
    let amount = "0.0000001";
    const client = create_hedge({
      manifest,
      adapter: adapter({
        loanToken: async () => ({ chain_id: 296, address, symbol: "USDC", decimals: 6 }),
      }),
      modal: async (_client, request) => {
        if (typeof request.amount !== "function") throw new Error("Missing amount calculation");
        await request.amount({ chain_id: 296, ...funding.recipient });
        return null;
      },
    });
    await expect(client.open({ amount: () => amount })).rejects.toThrow("6 decimal places");
    amount = "1e3";
    await expect(client.open({ amount: () => amount })).rejects.toThrow();
    amount = "0";
    const onFunded = vi.fn();
    await expect(client.open({ amount: () => amount, onFunded })).resolves.toBeNull();
    expect(onFunded).not.toHaveBeenCalled();
  });
  it("requires a deferred amount to be resolved before reporting funded continuation", async () => {
    const client = create_hedge({
      manifest,
      adapter: adapter({
        loanToken: async () => ({ chain_id: 296, address, symbol: "USDC", decimals: 6 }),
        funding: async () => result,
      }),
      modal: async () => ({ credit_id: "loan-1" }),
    });
    const onFunded = vi.fn();
    await expect(client.open({ amount: () => "1", onFunded })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    expect(onFunded).not.toHaveBeenCalled();
  });
  it("validates amount-only precision and confirms the requested asset before continuation", async () => {
    const modal = vi.fn(async () => ({ credit_id: "loan-1" }));
    const onFunded = vi.fn();
    const client = create_hedge({
      manifest,
      modal,
      adapter: adapter({
        loanToken: async () => ({ chain_id: 296, address, symbol: "USDC", decimals: 6 }),
        funding: async () => result,
      }),
    });
    await expect(client.open({ amount: "0.0000001", onFunded })).rejects.toThrow(
      "6 decimal places",
    );
    expect(modal).not.toHaveBeenCalled();
    await expect(client.open({ amount: "0.000002", onFunded })).rejects.toMatchObject({
      code: "FUNDING_MISMATCH",
    });
    expect(onFunded).not.toHaveBeenCalled();
    await expect(client.open({ amount: "0.000001", onFunded })).resolves.toEqual(result);
    expect(onFunded).toHaveBeenCalledOnce();
  });
  it("rejects unsupported adapters, zero and malformed amount-only requests before opening", async () => {
    const modal = vi.fn(async () => null);
    const client = create_hedge({ manifest, modal, adapter: adapter() });
    await expect(client.open({ amount: "1" })).rejects.toMatchObject({ code: "TOKEN_UNAVAILABLE" });
    for (const amount of ["1e3", "-1", "NaN", "", " 1"])
      await expect(client.open({ amount })).rejects.toThrow();
    expect(modal).not.toHaveBeenCalled();
  });
  it("shares deployment verification across concurrent reads", async () => {
    const verifyDeployment = vi.fn(async () => {});
    const client = create_hedge({
      manifest,
      adapter: adapter({ verifyDeployment, summary: async () => summary }),
    });
    await Promise.all([client.credit("loan-1").summary(), client.credit("loan-1").summary()]);
    expect(verifyDeployment).toHaveBeenCalledTimes(1);
  });
  it("allows verification retry without performing a read on failed verification", async () => {
    const verifyDeployment = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined);
    const read = vi.fn(async () => summary);
    const client = create_hedge({
      manifest,
      adapter: adapter({ verifyDeployment, summary: read }),
    });
    await expect(client.credit("loan-1").summary()).rejects.toThrow("offline");
    expect(read).not.toHaveBeenCalled();
    await client.credit("loan-1").summary();
    expect(verifyDeployment).toHaveBeenCalledTimes(2);
  });
  it("rejects funding and summaries for another loan or instance", async () => {
    const client = create_hedge({
      manifest,
      adapter: adapter({
        funding: async () => ({ ...result, credit_id: "loan-2" }),
        summary: async () => ({ ...summary, instance_id: "other" }),
      }),
    });
    await expect(client.credit("loan-1").funding()).rejects.toMatchObject({
      code: "CREDIT_MISMATCH",
    });
    await expect(client.credit("loan-1").summary()).rejects.toMatchObject({
      code: "INSTANCE_MISMATCH",
    });
  });
  it("does not call onFunded for a pending payout or switch to another loan on resume", async () => {
    const onFunded = vi.fn();
    const client = create_hedge({
      manifest,
      adapter: adapter({ funding: async () => null }),
      modal: async () => ({ credit_id: "loan-1" }),
    });
    await expect(client.open({ credit_id: "loan-1", onFunded })).rejects.toMatchObject({
      code: "PENDING",
      checkpoint: { credit_id: "loan-1" },
    });
    await expect(client.open({ credit_id: "loan-2", onFunded })).rejects.toMatchObject({
      code: "CREDIT_MISMATCH",
    });
    expect(onFunded).not.toHaveBeenCalled();
  });
  it("rereads actual funding and rejects an unrelated request before calling onFunded", async () => {
    const onFunded = vi.fn(),
      read = vi.fn(async () => result);
    const client = create_hedge({
      manifest,
      adapter: adapter({ funding: read }),
      modal: async () => ({ credit_id: "loan-1" }),
    });
    await expect(
      client.open({ funding: { ...funding, amount: 2n }, onFunded }),
    ).rejects.toMatchObject({ code: "FUNDING_MISMATCH" });
    expect(onFunded).not.toHaveBeenCalled();
    await expect(client.open({ funding, onFunded })).resolves.toEqual(result);
    expect(onFunded).toHaveBeenCalledWith(result);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("requires reviewed offer identity and propagates pending checkpoints without accepting twice", async () => {
    const accept = vi.fn(async () => {
      throw new PendingError("Awaiting collateral", {
        instance_id: "fixture",
        credit_id: "loan-1",
        stage: "lock_pending",
      });
    });
    const intent = create_hedge({ manifest, adapter: adapter({ accept }) }).intent({ funding });
    await expect(
      intent.accept({ offer_id: "offer-2", reviewedOffer: offer }),
    ).rejects.toMatchObject({ code: "OFFER_MISMATCH" });
    expect(accept).not.toHaveBeenCalled();
    await expect(
      intent.accept({ offer_id: "offer-1", reviewedOffer: offer }),
    ).rejects.toMatchObject({ checkpoint: { credit_id: "loan-1" } });
    expect(accept).toHaveBeenCalledTimes(1);
  });
  it("keeps borrower return and lender recovery operations on Base", async () => {
    const client = create_hedge({
      manifest,
      adapter: adapter({
        claimCollateral: async () => result.transaction,
        claimRecovery: async () => result.transaction,
      }),
    });
    await expect(client.credit("loan-1").collateral.claim()).rejects.toMatchObject({
      code: "CHAIN_MISMATCH",
    });
    await expect(client.operator(address).credit("loan-1").claimCollateral()).rejects.toMatchObject(
      { code: "CHAIN_MISMATCH" },
    );
    expect(client.operator(`0x${"3".repeat(40)}`).address).toBe(`0x${"3".repeat(40)}`);
    expect(() => client.operator(`0x${"0".repeat(40)}`)).toThrow(HedgeError);
  });
  it("returns subscription cleanup and validates incoming loan identity", async () => {
    const cleanup = vi.fn(),
      callback = vi.fn();
    let emit: ((value: CreditSummary) => void) | undefined;
    const client = create_hedge({
      manifest,
      adapter: adapter({
        subscribe: (_id, fn) => {
          emit = fn;
          return cleanup;
        },
      }),
    });
    const stop = await client.credit("loan-1").subscribe(callback);
    emit?.(summary);
    expect(callback).toHaveBeenCalledWith(summary);
    expect(() => emit?.({ ...summary, credit_id: "loan-2" })).toThrow(HedgeError);
    stop();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
  it("fails explicitly when a modal has not been implemented/configured", async () => {
    const client = create_hedge({ manifest, adapter: adapter() });
    await expect(client.open({ credit_id: "loan-1" })).rejects.toMatchObject({
      code: "MODAL_UNAVAILABLE",
    });
  });
  it("snapshots the funding request before a modal can yield or caller input changes", async () => {
    const request = { ...funding, amount: 1n };
    const onFunded = vi.fn();
    const client = create_hedge({
      manifest,
      adapter: adapter({ funding: async () => result }),
      modal: async (_client, options) => {
        request.amount = 2n;
        expect(options).not.toHaveProperty("onFunded");
        expect(() => {
          if (options.funding) options.funding.amount = 2n;
        }).toThrow();
        return { credit_id: "loan-1" };
      },
    });
    await expect(client.open({ funding: request, onFunded })).resolves.toEqual(result);
    expect(onFunded).toHaveBeenCalledTimes(1);
  });
  it("rejects a reviewed pledge or funding amount mismatch before an adapter signs", async () => {
    const accept = vi.fn();
    const client = create_hedge({ manifest, adapter: adapter({ accept }) });
    await expect(
      client.intent({ funding }).accept({
        offer_id: offer.id,
        reviewedOffer: { ...offer, funding: { ...funding, amount: 2n } },
      }),
    ).rejects.toMatchObject({ code: "FUNDING_MISMATCH" });
    await expect(
      client
        .intent({ funding, collateral: { chain_id: 84532, asset: address, amount: 2n } })
        .accept({ offer_id: offer.id, reviewedOffer: offer }),
    ).rejects.toMatchObject({ code: "OFFER_MISMATCH" });
    expect(accept).not.toHaveBeenCalled();
  });
  it("passes detached presentation context without granting app execution authority", async () => {
    const context = {
      title: "Borrow to swap",
      description: "USDC to HBAR",
      continueLabel: "Continue to swap",
    };
    const onFunded = vi.fn();
    const client = create_hedge({
      manifest,
      adapter: adapter({ funding: async () => result }),
      modal: async (_client, request) => {
        context.continueLabel = "Changed later";
        expect(request.context?.continueLabel).toBe("Continue to swap");
        expect(request).not.toHaveProperty("onFunded");
        expect(() => {
          request.context!.title = "Mutated";
        }).toThrow();
        return { credit_id: "loan-1" };
      },
    });
    await client.open({ funding, context, onFunded });
    expect(onFunded).toHaveBeenCalledTimes(1);
    expect(() => {
      client.manifest.base.chain_id = 1;
    }).toThrow();
  });
});

describe("independent operator resources", () => {
  it("binds each handle to its own wallet and passes that wallet to capital operations", async () => {
    const second = `0x${"3".repeat(40)}`;
    const deposit = vi.fn(async () => result.transaction);
    const summary = vi.fn(async (operator: string) => ({
      instance_id: manifest.instance_id,
      operator,
      free_capital: 9n,
      reserved_capital: 1n,
    }));
    const client = create_hedge({
      manifest,
      adapter: adapter({ deposit, operatorSummary: summary }),
    });
    expect((await client.operator(second).summary()).operator).toBe(second);
    await client.operator(second).deposit({ token: address, amount: 5n });
    expect(deposit).toHaveBeenCalledWith(second, { token: address, amount: 5n });
  });
  it("rejects another operator's summary and offers before publishing", async () => {
    const second = `0x${"3".repeat(40)}`;
    const publishOffer = vi.fn();
    const client = create_hedge({
      manifest,
      adapter: adapter({
        operatorSummary: async () => ({
          instance_id: manifest.instance_id,
          operator: address,
          free_capital: 9n,
          reserved_capital: 1n,
        }),
        operatorOffers: async () => [offer],
        publishOffer,
      }),
    });
    await expect(client.operator(second).summary()).rejects.toMatchObject({
      code: "OPERATOR_MISMATCH",
    });
    await expect(client.operator(second).offers()).rejects.toMatchObject({
      code: "OPERATOR_MISMATCH",
    });
    await expect(client.operator(second).publishOffer(offer)).rejects.toMatchObject({
      code: "OPERATOR_MISMATCH",
    });
    expect(publishOffer).not.toHaveBeenCalled();
  });
});
