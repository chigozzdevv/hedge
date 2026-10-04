import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeFunctionData, encodeFunctionData, type Hex } from "viem";
import { hedgeLendingAbi } from "@hedge/bindings";
import { HedgeError, tokenAbi, type EvmHedgeReader, type EvmTransaction } from "@hedge/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testConfig } from "../../packages/schema/test/config-fixture.js";
import { liquidityRequest, runLiquidity as run, validateLiquidityCall } from "../liquidity.js";
import type { SignedCall } from "../operator-wallet.js";
import type {
  LiquidityJournal,
  LiquidityStore,
} from "../../server/src/features/operator/liquidity.schema.js";

const state = vi.hoisted(() => ({
  sequence: 0,
  sends: 0,
  transactions: new Map<Hex, EvmTransaction>(),
}));
vi.mock("../operator-wallet.js", () => ({
  OperatorWallet: class {
    constructor(
      _root: string,
      private reader: EvmHedgeReader,
      private operator: string,
      private calls: SignedCall[],
      private save: () => Promise<void>,
      private validate: (tx: EvmTransaction) => void,
    ) {}
    async wallet() {
      return { chain_id: 296, address: this.operator, account_id: "0.0.123" };
    }
    async connect() {
      return this.wallet();
    }
    async broadcast(call: SignedCall) {
      return call.hash;
    }
    async send(tx: EvmTransaction) {
      this.validate(tx);
      const hash = `0x${(++state.sequence).toString(16).padStart(64, "0")}` as Hex;
      state.transactions.set(hash, tx);
      this.calls.push({ to: tx.to, data: tx.data, serialized: "0xdead", hash });
      state.sends++;
      await this.save();
      return hash;
    }
  },
}));

const operator = testConfig.operator;
const lending = testConfig.deployment.hedera.contract;
const token = `0x${"3".repeat(40)}` as Hex;
let root: string;
let free: bigint;
let allowance: bigint;
let reader: EvmHedgeReader;
let failCapitalOnce: boolean;
let rejectAllReceipts: boolean;
let revertCapitalOnce: boolean;
let journal: LiquidityJournal | undefined;
let receipts: LiquidityJournal[];
let failSave: boolean;
const store: LiquidityStore = {
  read: async () => journal && structuredClone(journal),
  save: async (value) => {
    if (failSave) throw new Error("Database unavailable");
    journal = structuredClone(value);
  },
  complete: async (value, status = "complete") => {
    value.status = status;
    receipts.push(structuredClone(value));
    journal = undefined;
  },
  assertOwned: async () => undefined,
};
const runLiquidity = (
  root: string,
  reader: EvmHedgeReader,
  operator: string,
  request: Parameters<typeof run>[3],
) => run(root, reader, operator, request, undefined, store);
beforeEach(() => {
  journal = undefined;
  receipts = [];
  failSave = false;
  root = mkdtempSync(join(tmpdir(), "hedge-liquidity-"));
  free = 5_000_000n;
  allowance = 0n;
  state.sequence = 0;
  state.sends = 0;
  state.transactions.clear();
  failCapitalOnce = false;
  rejectAllReceipts = false;
  revertCapitalOnce = false;
  const applied = new Set<Hex>();
  reader = {
    lendingAbi: hedgeLendingAbi,
    manifest: testConfig.deployment,
    config: { resolveAccount: async () => "0.0.123" },
    address: () => lending,
    loanToken: async () => token,
    token: async () => ({ address: token, symbol: "USDC", decimals: 6, chain_id: 296 }),
    verifyDeployment: async () => undefined,
    clients: {
      hedera: {
        getBalance: async () => 20n * 10n ** 18n,
        readContract: async ({ functionName }: { functionName: string }) => {
          if (functionName === "freeCapital") return free;
          if (functionName === "reservedCapital") return 2_000_000n;
          if (functionName === "allowance") return allowance;
          if (functionName === "balanceOf") return 20_000_000n;
          throw new Error("Unexpected read");
        },
        getTransaction: async ({ hash }: { hash: Hex }) => {
          const tx = state.transactions.get(hash)!;
          return { from: operator, to: tx.to, input: tx.data, value: 0n };
        },
      },
    },
    confirmed: async (_chain: string, hash: Hex) => {
      const tx = state.transactions.get(hash)!;
      if (revertCapitalOnce && tx.to === lending) {
        revertCapitalOnce = false;
        throw new HedgeError("TRANSACTION_REVERTED", "The transaction reverted");
      }
      if (rejectAllReceipts || (failCapitalOnce && tx.to === lending)) {
        failCapitalOnce = false;
        throw new Error("Receipt temporarily unavailable");
      }
      if (applied.has(hash)) return;
      applied.add(hash);
      if (tx.to === token) {
        const decoded = decodeFunctionData({ abi: tokenAbi, data: tx.data });
        if (decoded.functionName === "approve") allowance = decoded.args[1];
      } else {
        const decoded = decodeFunctionData({ abi: hedgeLendingAbi, data: tx.data });
        if (decoded.functionName === "deposit") free += decoded.args[0];
        if (decoded.functionName === "withdraw") free -= decoded.args[0];
      }
    },
  } as unknown as EvmHedgeReader;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("managed operator liquidity", () => {
  it.each([
    ["deposit"],
    ["withdraw", "0"],
    ["deposit", "1e6"],
    ["deposit", "-1"],
    ["status", "1"],
    ["deposit", "1", "extra"],
  ])("rejects malformed arguments %j before signing", (...args) => {
    expect(() => liquidityRequest(args)).toThrow();
  });
  it("reads available and reserved capital without accessing signer credentials", async () => {
    await runLiquidity(root, reader, operator, liquidityRequest([]));
    expect(state.sends).toBe(0);
    expect(existsSync(join(root, ".hedge/liquidity"))).toBe(false);
    expect(console.log).toHaveBeenCalledWith("Available: 5 USDC");
    expect(console.log).toHaveBeenCalledWith("Reserved: 2 USDC");
  });
  it("uses SDK approval and deposit, then archives only after confirmed receipts", async () => {
    await runLiquidity(root, reader, operator, { action: "deposit", amount: "1.25" });
    expect(state.sends).toBe(2);
    expect(free).toBe(6_250_000n);
    expect(receipts).toHaveLength(1);
    expect(journal).toBeUndefined();
    expect(receipts[0].status).toBe("complete");
    expect(receipts[0].calls).toHaveLength(2);
    expect(existsSync(join(root, ".hedge/liquidity"))).toBe(false);
  });
  it("resumes the same capital hash after interrupted confirmation without a second deposit", async () => {
    failCapitalOnce = true;
    const request = { action: "deposit", amount: "1" } as const;
    await expect(runLiquidity(root, reader, operator, request)).rejects.toThrow("temporarily");
    expect(state.sends).toBe(2);
    await expect(
      runLiquidity(root, reader, operator, { action: "deposit", amount: "2" }),
    ).rejects.toThrow("pending");
    await runLiquidity(root, reader, operator, request);
    expect(state.sends).toBe(2);
    expect(free).toBe(6_000_000n);
  });
  it("does not trust a completed checkpoint when the canonical receipt cannot be read", async () => {
    failCapitalOnce = true;
    const request = { action: "deposit", amount: "1" } as const;
    await expect(runLiquidity(root, reader, operator, request)).rejects.toThrow();
    journal!.status = "complete";
    rejectAllReceipts = true;
    await expect(runLiquidity(root, reader, operator, request)).rejects.toThrow("temporarily");
    expect(journal).toBeDefined();
    expect(state.sends).toBe(2);
  });
  it("withdraws only free capital and leaves reserved capital alone", async () => {
    await expect(
      runLiquidity(root, reader, operator, { action: "withdraw", amount: "5.000001" }),
    ).rejects.toThrow("available");
    expect(state.sends).toBe(0);
    await runLiquidity(root, reader, operator, { action: "withdraw", amount: "2" });
    expect(state.sends).toBe(1);
    expect(free).toBe(3_000_000n);
  });
  it("archives canonical reverts as failures so a later explicit command can retry", async () => {
    revertCapitalOnce = true;
    const request = { action: "withdraw", amount: "1" } as const;
    await expect(runLiquidity(root, reader, operator, request)).rejects.toThrow("reverted");
    expect(free).toBe(5_000_000n);
    expect(journal).toBeUndefined();
    expect(receipts[0].status).toBe("failed");
    await runLiquidity(root, reader, operator, request);
    expect(free).toBe(4_000_000n);
    expect(state.sends).toBe(2);
  });
  it("rejects precision beyond the real lending token decimals", async () => {
    await expect(
      runLiquidity(root, reader, operator, { action: "deposit", amount: "0.0000001" }),
    ).rejects.toThrow("6 decimal");
    expect(state.sends).toBe(0);
  });
  it("does not continue to confirmation when durable transaction storage fails", async () => {
    failSave = true;
    await expect(
      runLiquidity(root, reader, operator, { action: "deposit", amount: "1" }),
    ).rejects.toThrow("Database unavailable");
    expect(free).toBe(5_000_000n);
    expect(receipts).toHaveLength(0);
  });
  it("rejects arbitrary approvals, native transfers and unrelated calls", () => {
    const intent = { token, action: "deposit", amount: "1000000" } as const;
    const data = encodeFunctionData({
      abi: tokenAbi,
      functionName: "approve",
      args: [lending, 1_000_000n],
    });
    expect(() =>
      validateLiquidityCall({ chain: "hedera", to: token, data }, intent, lending),
    ).not.toThrow();
    const unlimited = encodeFunctionData({
      abi: tokenAbi,
      functionName: "approve",
      args: [lending, 2n ** 256n - 1n],
    });
    expect(() =>
      validateLiquidityCall({ chain: "hedera", to: token, data: unlimited }, intent, lending),
    ).toThrow("differs");
    expect(() =>
      validateLiquidityCall({ chain: "hedera", to: token, data, value: 1n }, intent, lending),
    ).toThrow("native");
    expect(() =>
      validateLiquidityCall({ chain: "base", to: token, data }, intent, lending),
    ).toThrow("another chain");
    const unrelated = encodeFunctionData({
      abi: tokenAbi,
      functionName: "approve",
      args: [`0x${"4".repeat(40)}`, 1_000_000n],
    });
    expect(() =>
      validateLiquidityCall({ chain: "hedera", to: token, data: unrelated }, intent, lending),
    ).toThrow("differs");
  });
});
