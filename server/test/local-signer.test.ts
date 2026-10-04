import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keccak256, parseTransaction, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { EvmHedgeReader, EvmTransaction } from "@hedge/sdk";
import { LocalTestSigner } from "../src/shared/chain/local-signer.js";

const storage = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  save: vi.fn(),
  lease: vi.fn(),
}));
vi.mock("../src/shared/database/records.js", () => ({
  readRecord: async (scope: string, key: string) =>
    storage.values.get(JSON.stringify([scope, key])),
  createRecord: async (scope: string, key: string, value: unknown) => {
    await storage.save();
    const id = JSON.stringify([scope, key]);
    if (!storage.values.has(id)) storage.values.set(id, structuredClone(value));
    return storage.values.get(id);
  },
  withRecordLease: async (
    _scope: string,
    action: (assertOwned: () => Promise<void>) => unknown,
  ) => {
    await storage.lease();
    return action(async () => {
      await storage.lease();
    });
  },
}));
const hederaKey = `0x${"12".repeat(32)}` as Hex;
const baseKey = `0x${"34".repeat(32)}` as Hex;
const wallets = {
  hedera: { address: privateKeyToAccount(hederaKey).address, private_key: hederaKey },
  base: { address: privateKeyToAccount(baseKey).address, private_key: baseKey },
};
const tx: EvmTransaction = {
  chain: "hedera",
  to: `0x${"56".repeat(20)}`,
  data: "0x1234",
  value: 123n,
  key: "instance:loan:message",
  label: "Relay message",
};
let root: string, signer: LocalTestSigner;
const client = {
  getChainId: vi.fn(),
  getTransactionCount: vi.fn(),
  getGasPrice: vi.fn(),
  getBalance: vi.fn(),
  estimateGas: vi.fn(),
  sendRawTransaction: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
};
beforeEach(() => {
  vi.clearAllMocks();
  storage.values.clear();
  storage.save.mockResolvedValue(undefined);
  storage.lease.mockResolvedValue(undefined);
  root = mkdtempSync(join(tmpdir(), "hedge-signer-"));
  mkdirSync(join(root, ".hedge"));
  writeFileSync(join(root, ".hedge/wallets.json"), JSON.stringify(wallets), { mode: 0o600 });
  client.getChainId.mockResolvedValue(296);
  client.getTransactionCount.mockResolvedValue(2);
  client.getGasPrice.mockResolvedValue(1n);
  client.getBalance.mockResolvedValue(100n * 10n ** 18n);
  client.estimateGas.mockResolvedValue(21000n);
  client.sendRawTransaction.mockImplementation(
    async ({ serializedTransaction }: { serializedTransaction: Hex }) =>
      keccak256(serializedTransaction),
  );
  client.waitForTransactionReceipt.mockResolvedValue({ status: "success" });
  signer = new LocalTestSigner(root, {
    manifest: { hedera: { chain_id: 296 }, base: { chain_id: 84532 } },
    clients: { hedera: client, base: client },
  } as unknown as EvmHedgeReader);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
describe("database signing recovery", () => {
  it("persists before broadcast, recovers the identical signed hash and creates no journal files", async () => {
    const first = await signer.send(tx, false);
    expect(storage.save.mock.invocationCallOrder[0]).toBeLessThan(
      client.sendRawTransaction.mock.invocationCallOrder[0]!,
    );
    client.getTransactionCount.mockResolvedValue(99);
    expect(await signer.send(tx, false)).toBe(first);
    expect(client.estimateGas).toHaveBeenCalledTimes(1);
    expect(client.sendRawTransaction.mock.calls[0]?.[0]).toEqual(
      client.sendRawTransaction.mock.calls[1]?.[0],
    );
    expect(await signer.saved(tx.chain, tx.key)).toEqual({ hash: first, value: 123n });
    expect(readdirSync(join(root, ".hedge"))).toEqual(["wallets.json"]);
  });
  it("never broadcasts when saving recovery or acquiring its database lease fails", async () => {
    storage.save.mockRejectedValueOnce(new Error("Database unavailable"));
    await expect(signer.send(tx, false)).rejects.toThrow("Database unavailable");
    expect(client.sendRawTransaction).not.toHaveBeenCalled();
    storage.lease.mockRejectedValueOnce(new Error("Lease lost"));
    await expect(signer.send(tx, false)).rejects.toThrow("Lease lost");
    expect(client.sendRawTransaction).not.toHaveBeenCalled();
  });
  it("rejects a changed operation and tampered saved bytes before rebroadcast", async () => {
    await signer.send(tx, false);
    client.sendRawTransaction.mockClear();
    await expect(signer.send({ ...tx, data: "0xabcd" }, false)).rejects.toThrow("does not match");
    const record = storage.values.values().next().value as { hash: Hex };
    record.hash = `0x${"0".repeat(64)}`;
    await expect(signer.send(tx, false)).rejects.toThrow("does not match");
    expect(client.sendRawTransaction).not.toHaveBeenCalled();
  });
  it("checks chain, nonce and retained gas before persisting a signature", async () => {
    client.getChainId.mockResolvedValueOnce(84532);
    await expect(signer.send(tx, false)).rejects.toThrow("wrong chain");
    client.getTransactionCount.mockResolvedValueOnce(2).mockResolvedValueOnce(3);
    await expect(signer.send(tx, false)).rejects.toThrow("pending transaction");
    client.getBalance.mockResolvedValueOnce(0n);
    await expect(signer.send(tx, false)).rejects.toThrow("retained reserve");
    expect(storage.save).not.toHaveBeenCalled();
    expect(client.sendRawTransaction).not.toHaveBeenCalled();
  });
  it("isolates borrowed test-wallet recovery from operator recovery", async () => {
    await signer.send(tx, true);
    expect(await signer.saved(tx.chain, tx.key)).toBeUndefined();
    await signer.send(tx, false);
    expect(storage.values.size).toBe(2);
    const signed = client.sendRawTransaction.mock.calls.map((call) =>
      parseTransaction(call[0].serializedTransaction as Hex),
    );
    expect(signed).toHaveLength(2);
  });
});
