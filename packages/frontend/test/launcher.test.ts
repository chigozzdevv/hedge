import { testRecord } from "../../schema/test/config-fixture";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import {
  EvmHedgeReader,
  type ClientConfig,
  type CreditSummary,
  type FundingResult,
  type EvmWallet,
} from "@hedge/sdk";
import { HedgeRuntime } from "../src/provider/hedge-runtime";
import { setupHedge } from "../src/provider/hedge-session";
import { HedgeContext, HedgeProvider } from "../src/provider/hedge-provider";
import { UseHedge } from "../src/provider/use-hedge";

import { deploymentConfigSchema } from "@hedge/schema";

const record = structuredClone(testRecord);
const config: ClientConfig = deploymentConfigSchema.parse(record);
const id = `0x${"1".repeat(64)}`;
const summary: CreditSummary = {
  instance_id: config.deployment.instance_id,
  credit_id: id,
  agreement_hash: id,
  state: "funded",
  collateral_state: "locked",
  amount_due: 102000n,
  payment_deadline: 2_000_000_000,
};
const funding: FundingResult = {
  instance_id: config.deployment.instance_id,
  credit_id: id,
  offer_id: id,
  agreement_hash: id,
  funding: {
    token: config.deployment.hedera.contract,
    amount: 100000n,
    recipient: { address: config.operator, account_id: "0.0.123" },
  },
  transaction: { chain: "hedera", hash: id, confirmed: true },
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}
async function fixture() {
  vi.spyOn(EvmHedgeReader.prototype, "verifyDeployment").mockResolvedValue();
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() });
  const wallet = {
    connect: vi.fn(),
    wallet: vi.fn<EvmWallet["wallet"]>(async () => null),
    send: vi.fn(),
  };
  const session = await setupHedge({ config, wallet });
  const open = vi.spyOn(session.client, "open").mockResolvedValue(funding);
  const readSummary = vi.spyOn(session.adapter, "summary").mockResolvedValue(summary);
  const recover = vi.spyOn(session.adapter, "outstandingLoans").mockResolvedValue([]);
  const setup = vi.fn(async () => session);
  const runtime = new HedgeRuntime({ config, wallet }, setup);
  return { runtime, session, open, readSummary, recover, setup, wallet };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("declarative Hedge launcher", () => {
  it("renders the host and styled launcher on the server without any network or wallet prompts", () => {
    const request = vi.fn<typeof fetch>();
    const wallet = { connect: vi.fn(), wallet: vi.fn(), send: vi.fn() };
    const html = renderToString(
      createElement(HedgeProvider, {
        wallet,
        request,
        children: [
          createElement("form", { key: "swap" }, "Host swap"),
          createElement(UseHedge, { key: "hedge", amount: "0.1" }),
        ],
      }),
    );
    expect(html).toContain("Host swap");
    expect(html).toContain("hedge-launch-button");
    expect(html).toContain("Use Hedge");
    expect(request).not.toHaveBeenCalled();
    expect(wallet.connect).not.toHaveBeenCalled();
    expect(html).not.toContain("<dialog");
  });
  it("shares initialization and blocks rapid/multiple launchers through the continuation", async () => {
    const f = await fixture();
    expect(f.setup).not.toHaveBeenCalled();
    await Promise.all([f.runtime.ready(), f.runtime.ready()]);
    expect(f.setup).toHaveBeenCalledOnce();
    const callback = deferred<void>();
    const onContinue = vi.fn(() => callback.promise);
    const first = f.runtime.continue({ amount: "0.1", onContinue });
    await vi.waitFor(() => expect(onContinue).toHaveBeenCalledOnce());
    await expect(f.runtime.continue({ amount: "0.2" })).rejects.toMatchObject({
      code: "MODAL_BUSY",
    });
    expect(f.open).toHaveBeenCalledOnce();
    expect(f.runtime.getSnapshot().busy).toBe(true);
    callback.resolve();
    await first;
    expect(f.runtime.getSnapshot().busy).toBe(false);
  });
  it("retains the accepted loan when the host callback fails, even if the amount changes", async () => {
    const f = await fixture();
    f.open.mockImplementationOnce(async () => {
      f.session.modal.remember({ instance_id: config.deployment.instance_id, credit_id: id });
      return funding;
    });
    await expect(
      f.runtime.continue({
        amount: "0.1",
        onContinue: async () => {
          throw new Error("Quote service offline");
        },
      }),
    ).rejects.toThrow("Quote service offline");
    expect(f.runtime.getSnapshot().error?.message).toBe("Quote service offline");
    const onContinue = vi.fn();
    await f.runtime.continue({ amount: "10", continueLabel: "Continue to swap", onContinue });
    expect(f.open.mock.calls[1][0]).toMatchObject({
      credit_id: id,
      context: { continueLabel: "Continue to swap" },
    });
    expect(f.open.mock.calls[1][0]).not.toHaveProperty("amount");
    expect(onContinue).toHaveBeenCalledWith(funding);
    expect(f.runtime.getSnapshot().error).toBeUndefined();
  });
  it("does not continue after dismissal, failed funding or provider unmount", async () => {
    const f = await fixture();
    const onContinue = vi.fn();
    f.open.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("Payout pending"));
    await expect(f.runtime.continue({ amount: "0.1", onContinue })).resolves.toBeNull();
    await expect(f.runtime.continue({ amount: "0.1", onContinue })).rejects.toThrow(
      "Payout pending",
    );
    const pending = deferred<FundingResult>();
    f.open.mockReturnValueOnce(pending.promise);
    const active = f.runtime.continue({ amount: "0.1", onContinue });
    await vi.waitFor(() => expect(f.open).toHaveBeenCalledTimes(3));
    f.runtime.deactivate();
    f.runtime.activate();
    pending.resolve(funding);
    await active;
    expect(onContinue).not.toHaveBeenCalled();
    expect(f.runtime.getSnapshot().busy).toBe(false);
  });
  it("shows a local configuration error while retaining the host and supports retry", async () => {
    const setup = vi
      .fn<typeof setupHedge>()
      .mockRejectedValue(new Error("Generated config is missing"));
    const f = await fixture();
    const runtime = new HedgeRuntime({ wallet: f.wallet }, setup);
    await expect(runtime.continue({ amount: "0.1" })).rejects.toThrow("Generated config");
    const html = renderToString(
      createElement(HedgeContext.Provider, {
        value: runtime,
        children: [
          createElement("form", { key: "swap" }, "Host swap"),
          createElement(UseHedge, { key: "hedge", amount: "0.1" }),
        ],
      }),
    );
    expect(html).toContain("Host swap");
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("disabled");
    setup.mockResolvedValueOnce(f.session);
    await runtime.continue({ amount: "0.1" });
    expect(runtime.getSnapshot().error).toBeUndefined();
  });
  it("recovers canonical outstanding loans before considering a new shortfall", async () => {
    const f = await fixture();
    f.wallet.wallet.mockResolvedValue({
      chain_id: 296,
      address: config.operator,
      account_id: "0.0.123",
    });
    f.recover.mockResolvedValue([id]);
    await f.runtime.continue({ amount: "10" });
    expect(f.open).toHaveBeenCalledWith(expect.objectContaining({ credit_id: id }));
    f.recover.mockResolvedValue([id, `0x${"2".repeat(64)}`]);
    await expect(f.runtime.continue({ amount: "10" })).rejects.toMatchObject({
      code: "LOAN_SELECTION_REQUIRED",
    });
    expect(f.open).toHaveBeenCalledOnce();
  });
  it("opens a saved settled receipt for zero shortfall, but allows explicit new funding after settlement", async () => {
    const f = await fixture();
    f.session.modal.remember({ instance_id: config.deployment.instance_id, credit_id: id });
    f.readSummary.mockResolvedValue({
      ...summary,
      state: "repaid",
      amount_due: 0n,
      collateral_state: "returned",
    });
    await f.runtime.continue({ amount: "0" });
    expect(f.open.mock.calls[0][0]).toHaveProperty("credit_id", id);
    await f.runtime.continue({ amount: "0.1" });
    expect(f.open.mock.calls[1][0]).toHaveProperty("amount", "0.1");
    expect(f.open.mock.calls[1][0]).not.toHaveProperty("credit_id");
  });
  it("supports React effect cleanup/restart without accepting a stale setup", async () => {
    const f = await fixture();
    const pending = deferred<typeof f.session>();
    const setup = vi
      .fn<typeof setupHedge>()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(f.session);
    const runtime = new HedgeRuntime({ wallet: f.wallet }, setup);
    const first = runtime.ready();
    runtime.deactivate();
    runtime.activate();
    pending.resolve(f.session);
    await expect(first).rejects.toMatchObject({ code: "PROVIDER_CLOSED" });
    expect(runtime.getSnapshot().session).toBeUndefined();
    await expect(runtime.ready()).resolves.toBe(f.session.client);
    expect(setup).toHaveBeenCalledTimes(2);
  });
});
