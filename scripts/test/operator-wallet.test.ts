import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256, type Address, type Hex } from "viem";
import type { EvmHedgeReader } from "@hedge/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OperatorWallet, validateSignedCall, type SignedCall } from "../operator-wallet.js";

const folders: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of folders.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("liquidity signed transaction binding", () => {
  it("accepts the bound signer, chain and call; rejects altered hashes, recipients and senders", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const to = `0x${"12".repeat(20)}` as Address;
    const serialized = await account.signTransaction({
      chainId: 296,
      to,
      data: "0x1234",
      value: 0n,
      nonce: 0,
      gas: 100000n,
      gasPrice: 1n,
      type: "legacy",
    });
    const call = { to, data: "0x1234" as Hex, serialized, hash: keccak256(serialized) };
    const reader = { manifest: { hedera: { chain_id: 296 } } } as EvmHedgeReader;
    await expect(validateSignedCall(call, reader, account.address)).resolves.toBeUndefined();
    await expect(
      validateSignedCall({ ...call, hash: `0x${"00".repeat(32)}` }, reader, account.address),
    ).rejects.toThrow("differs");
    await expect(
      validateSignedCall({ ...call, to: `0x${"34".repeat(20)}` }, reader, account.address),
    ).rejects.toThrow("differs");
    await expect(validateSignedCall(call, reader, `0x${"56".repeat(20)}`)).rejects.toThrow(
      "differs",
    );
    const differentChain = { manifest: { hedera: { chain_id: 297 } } } as EvmHedgeReader;
    await expect(validateSignedCall(call, differentChain, account.address)).rejects.toThrow(
      "differs",
    );
  });
  it("never broadcasts a signed transaction if database persistence or its lease fails", async () => {
    const private_key = generatePrivateKey();
    const account = privateKeyToAccount(private_key);
    const root = mkdtempSync(join(tmpdir(), "hedge-liquidity-wallet-"));
    folders.push(root);
    mkdirSync(join(root, ".hedge"), { mode: 0o700 });
    const baseKey = generatePrivateKey();
    writeFileSync(
      join(root, ".hedge/wallets.json"),
      JSON.stringify({
        hedera: { address: account.address, private_key },
        base: { address: privateKeyToAccount(baseKey).address, private_key: baseKey },
      }),
      { mode: 0o600 },
    );
    const to = `0x${"12".repeat(20)}` as Address;
    const send = vi.fn(async () => "0xab" as Hex);
    const reader = {
      manifest: { hedera: { chain_id: 296 } },
      config: { rpc: { hedera: "https://fixture.invalid" } },
      clients: {
        hedera: {
          getTransactionCount: async () => 0,
          getGasPrice: async () => 1n,
          getBalance: async () => 20n * 10n ** 18n,
          estimateGas: async () => 100000n,
          sendRawTransaction: send,
        },
      },
    } as unknown as EvmHedgeReader;
    const calls: SignedCall[] = [];
    const wallet = new OperatorWallet(
      root,
      reader,
      account.address,
      calls,
      async () => {
        throw new Error("Database unavailable");
      },
      () => undefined,
      10n ** 18n,
      0n,
    );
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(
      wallet.send({ chain: "hedera", to, data: "0x1234", key: "test", label: "test" }),
    ).rejects.toThrow("Database unavailable");
    expect(send).not.toHaveBeenCalled();
    const expired = new OperatorWallet(
      root,
      reader,
      account.address,
      calls,
      async () => undefined,
      () => undefined,
      10n ** 18n,
      0n,
      () => undefined,
      async () => {
        throw new Error("lease lost");
      },
    );
    await expect(expired.broadcast(calls[0])).rejects.toThrow("lease lost");
    expect(send).not.toHaveBeenCalled();
  });
});
