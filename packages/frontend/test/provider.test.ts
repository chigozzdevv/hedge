import { testRecord } from "../../schema/test/config-fixture";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { EvmHedgeReader, type ClientConfig, type EvmWallet } from "@hedge/sdk";
import { setupHedge } from "../src/provider/hedge-session";
import { browserJournal } from "../src/provider/browser-journal";
import { HedgeProvider, useHedge } from "../src/provider/hedge-provider";

import { deploymentConfigSchema } from "@hedge/schema";

const record = structuredClone(testRecord);
const config: ClientConfig = deploymentConfigSchema.parse(record);
const loanId = `0x${"1".repeat(64)}`;
class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
}
const wallet = (): EvmWallet => ({
  connect: vi.fn(async () => {
    throw new Error("Wallet prompts are forbidden at startup");
  }),
  wallet: vi.fn(async () => null),
  send: vi.fn(async () => {
    throw new Error("Signing is forbidden at startup");
  }),
});
beforeEach(() => {
  vi.stubGlobal("localStorage", new MemoryStorage());
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("provider setup and recovery", () => {
  it("verifies deployment, restores the same loan and creates no offer or wallet prompt", async () => {
    const verify = vi.spyOn(EvmHedgeReader.prototype, "verifyDeployment").mockResolvedValue();
    const saved = browserJournal(config.deployment.instance_id, config.operator);
    saved.journal.checkpoint!({
      instance_id: config.deployment.instance_id,
      credit_id: loanId,
      stage: "accepted",
    });
    const appWallet = wallet(),
      request = vi.fn<typeof fetch>();
    const session = await setupHedge({ config, wallet: appWallet, request });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(session.modal.getSnapshot().creditId).toBe(loanId);
    expect(session.adapter.options.wallet).toBe(appWallet);
    expect(appWallet.connect).not.toHaveBeenCalled();
    expect(appWallet.send).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
  it("stops setup when real deployment verification fails", async () => {
    vi.spyOn(EvmHedgeReader.prototype, "verifyDeployment").mockRejectedValue(
      new Error("Runtime mismatch"),
    );
    const appWallet = wallet();
    await expect(setupHedge({ config, wallet: appWallet })).rejects.toThrow("Runtime mismatch");
    expect(appWallet.send).not.toHaveBeenCalled();
  });
  it("reports missing config before constructing wallet services", async () => {
    const walletFactory = vi.fn(() => wallet());
    await expect(
      setupHedge({
        wallet: walletFactory,
        request: async () => new Response(null, { status: 404 }),
      }),
    ).rejects.toMatchObject({ code: "CONFIG_MISSING" });
    expect(walletFactory).not.toHaveBeenCalled();
  });
  it("sends discovery and relay through the configured authenticated transport", async () => {
    vi.spyOn(EvmHedgeReader.prototype, "verifyDeployment").mockResolvedValue();
    const request = vi.fn<typeof fetch>(async () => Response.json({ ids: [loanId] }));
    const session = await setupHedge({ config, wallet: wallet(), request });
    const funding = {
      token: config.deployment.hedera.contract,
      amount: 100n,
      recipient: { address: config.operator, account_id: "0.0.123" },
    };
    expect(await session.adapter.options.discover({ funding }, config.operator)).toEqual([loanId]);
    expect(JSON.parse(request.mock.calls[0][1]!.body as string).request.funding.amount).toBe("100");
    expect(request.mock.calls[0][0]).toBe(`${config.operator_url}/offers`);
    await session.adapter.options.relay(loanId);
    expect(request.mock.calls[1][0]).toBe(`${config.operator_url}/relay`);
    // Service acknowledgements never establish payout; existing SDK operations reread contracts.
    expect(session.modal.getSnapshot().screen).toBe("connect");
  });
  it("rejects malformed discovery and failed service responses", async () => {
    vi.spyOn(EvmHedgeReader.prototype, "verifyDeployment").mockResolvedValue();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ success: true }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    const session = await setupHedge({ config, wallet: wallet(), request });
    const funding = {
      token: config.deployment.hedera.contract,
      amount: 100n,
      recipient: { address: config.operator, account_id: "0.0.123" },
    };
    await expect(
      session.adapter.options.discover({ funding }, config.operator),
    ).rejects.toMatchObject({ code: "OFFER_INVALID" });
    await expect(session.adapter.options.relay(loanId)).rejects.toMatchObject({
      code: "OPERATOR_UNAVAILABLE",
    });
  });
  it("refuses corrupted saved hashes/loans instead of starting another debt", () => {
    const prefix = `hedge:${config.deployment.instance_id}:${config.operator.toLowerCase()}:`;
    localStorage.setItem(`${prefix}loan`, "broken");
    localStorage.setItem(`${prefix}tx:accept`, "broken");
    const saved = browserJournal(config.deployment.instance_id, config.operator);
    expect(saved.restore).toThrow("Saved loan is invalid");
    expect(() => saved.journal.get("accept")).toThrow("Saved transaction hash is invalid");
    expect(localStorage.getItem(`${prefix}loan`)).toBe("broken");
  });
  it("renders host children during SSR without initializing Hedge and reports missing provider usage", () => {
    expect(
      renderToString(createElement(HedgeProvider, { wallet: wallet(), children: "swap" })),
    ).toBe("swap");
    function MissingProvider() {
      useHedge();
      return null;
    }
    expect(() => renderToString(createElement(MissingProvider))).toThrow(
      "Mount HedgeProvider above useHedge",
    );
  });
});

describe("operator recovery separation", () => {
  it("keeps two app operators' checkpoints and transaction hashes separate on shared contracts", () => {
    const other = `0x${"9".repeat(40)}`;
    const first = browserJournal(config.deployment.instance_id, config.operator);
    const second = browserJournal(config.deployment.instance_id, other);
    first.journal.checkpoint!({
      instance_id: config.deployment.instance_id,
      credit_id: loanId,
      stage: "accepted",
    });
    first.journal.set("accept", `0x${"2".repeat(64)}`);
    expect(second.restore()).toBeUndefined();
    expect(second.journal.get("accept")).toBeUndefined();
    expect(first.restore()?.credit_id).toBe(loanId);
  });
});
