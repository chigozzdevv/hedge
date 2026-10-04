import { encodeFunctionData } from "viem";
import { hedgeLendingAbi } from "@hedge/bindings";
import type { EvmHedgeReader } from "@hedge/sdk";
import type { LocalTestSigner } from "../../shared/chain/local-signer.js";

/** Sponsors immutable outboxes. Receiver fingerprints, never submission counts, establish delivery. */
export function createCcipRelay(
  reader: EvmHedgeReader,
  signer: Pick<LocalTestSigner, "saved" | "send">,
) {
  const manifest = reader.manifest;
  const relayJobs = new Map<string, Promise<void>>();
  const relay = (id: string): Promise<void> => {
    if (relayJobs.has(id)) return relayJobs.get(id)!;
    const job = (async () => {
      // The reader verifies this deployment, loan ID, agreement hash, parties and assets.
      await reader.loan(id);
      for (const kind of manifest.protocol_version === 3 ? [0, 1, 2, 3] : [0, 1, 2]) {
        const box = await reader.outbox(id, kind);
        if (box.payload === "0x" || box.delivered || box.submissions > 0n) continue;
        const key = `${manifest.instance_id}:${id}:message:${kind}`;
        const saved = await signer.saved(box.chain, key);
        // Anyone can sponsor, but neither this service nor the browser can modify the payload.
        const fee = await reader.clients[box.chain].readContract({
          address: reader.address(box.chain),
          abi: hedgeLendingAbi,
          functionName: "quoteMessage",
          args: [box.operation, 1_000_000n],
        });
        const value = saved?.value ?? (box.chain === "hedera" ? fee * 10n ** 10n : fee);
        if (value > (box.chain === "hedera" ? 12n * 10n ** 18n : 10n ** 15n))
          throw new Error("CCIP fee exceeds the configured testnet budget");
        const hash = await signer.send(
          {
            chain: box.chain,
            to: reader.address(box.chain),
            data: encodeFunctionData({
              abi: hedgeLendingAbi,
              functionName: "sendMessage",
              args: [box.operation, 1_000_000n],
            }),
            value,
            key,
            label: "Sponsor immutable CCIP message",
          },
          false,
        );
        await reader.confirmed(box.chain, hash);
      }
    })();
    relayJobs.set(id, job);
    void job.finally(() => relayJobs.delete(id)).catch(() => undefined);
    return job;
  };
  return relay;
}
