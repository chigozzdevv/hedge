import { describe, expect, it, vi } from "vitest";
import type { EvmHedgeReader, EvmTransaction } from "@hedge/sdk";
import { createCcipRelay } from "../src/features/credit/ccip-relay.js";

const borrower = `0x${"1".repeat(40)}`;
const hash = `0x${"a".repeat(64)}` as const;
function fixture() {
  const outbox = vi.fn(async (_id: string, kind: number) => ({
    chain: kind === 1 ? "base" : "hedera",
    operation: hash,
    payload: "0x1234",
    delivered: false,
    submissions: 0n,
  }));
  const reader = {
    manifest: { instance_id: hash },
    loan: vi.fn(async () => ({ agreement: { terms: { borrower } } })),
    outbox,
    address: () => borrower,
    clients: {
      hedera: { readContract: vi.fn(async () => 2n) },
      base: { readContract: vi.fn(async () => 2n) },
    },
    confirmed: vi.fn(async () => undefined),
  };
  const signer = {
    saved: vi.fn(async () => undefined as { hash: typeof hash; value: bigint } | undefined),
    send: vi.fn(async (_tx: EvmTransaction, _borrower: boolean) => hash),
  };
  return {
    reader,
    signer,
    outbox,
    relay: createCcipRelay(reader as unknown as EvmHedgeReader, signer),
  };
}
describe("automatic CCIP sponsorship", () => {
  it("deduplicates concurrent progress requests and converts only Hedera tinybar fees", async () => {
    const f = fixture();
    await Promise.all([f.relay(hash), f.relay(hash)]);
    expect(f.signer.send).toHaveBeenCalledTimes(3);
    expect(f.signer.send.mock.calls.map(([tx]) => tx.value)).toEqual([
      20_000_000_000n,
      2n,
      20_000_000_000n,
    ]);
    expect(f.reader.confirmed).toHaveBeenCalledTimes(3);
  });
  it("does not resubmit an undelivered message that was already submitted", async () => {
    const f = fixture();
    f.outbox.mockImplementation(async (_id, kind) => ({
      chain: kind === 1 ? "base" : "hedera",
      operation: hash,
      payload: "0x1234",
      delivered: false,
      submissions: 1n,
    }));
    await f.relay(hash);
    expect(f.signer.send).not.toHaveBeenCalled();
  });
  it("preserves the saved fee and operation key across source confirmation retries", async () => {
    const f = fixture();
    f.signer.saved.mockResolvedValue({ hash, value: 7n });
    f.reader.confirmed.mockRejectedValueOnce(new Error("RPC unavailable"));
    await expect(f.relay(hash)).rejects.toThrow("RPC unavailable");
    await f.relay(hash);
    const first = f.signer.send.mock.calls[0][0],
      retried = f.signer.send.mock.calls[1][0];
    expect(first.value).toBe(7n);
    expect(retried).toEqual(first);
  });
  it("relays a verified loan for another borrower using only the operator signer", async () => {
    const f = fixture();
    f.reader.loan.mockResolvedValue({ agreement: { terms: { borrower: `0x${"2".repeat(40)}` } } });
    await f.relay(hash);
    expect(f.signer.send).toHaveBeenCalledTimes(3);
    expect(f.signer.send.mock.calls.every(([, borrowerSigning]) => !borrowerSigning)).toBe(true);
  });
  it("does not sponsor an unknown or invalid canonical agreement", async () => {
    const f = fixture();
    f.reader.loan.mockRejectedValue(new Error("Canonical agreement binding is invalid"));
    await expect(f.relay(hash)).rejects.toThrow("binding");
    expect(f.outbox).not.toHaveBeenCalled();
    expect(f.signer.send).not.toHaveBeenCalled();
  });
});
