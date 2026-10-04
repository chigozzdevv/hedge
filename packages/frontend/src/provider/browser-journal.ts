import { HedgeError, type Checkpoint, type EvmJournal } from "@hedge/sdk";
import { hashSchema } from "@hedge/schema";

/** Public identifiers and hashes only. A restored loan is always reread onchain. */
export function browserJournal(
  instanceId: string,
  operator: string,
  storage: Storage = localStorage,
) {
  const prefix = `hedge:${instanceId}:${operator.toLowerCase()}:`;
  const journal: EvmJournal = {
    get: (key) => {
      const hash = storage.getItem(`${prefix}tx:${key}`);
      if (hash === null) return undefined;
      if (!/^0x[\da-fA-F]{64}$/.test(hash))
        throw new HedgeError("JOURNAL_INVALID", "Saved transaction hash is invalid");
      return hash as `0x${string}`;
    },
    set: (key, hash) => storage.setItem(`${prefix}tx:${key}`, hash),
    checkpoint: (checkpoint) => storage.setItem(`${prefix}loan`, JSON.stringify(checkpoint)),
  };
  const restore = (): Pick<Checkpoint, "instance_id" | "credit_id"> | undefined => {
    const value = storage.getItem(`${prefix}loan`);
    if (value === null) return undefined;
    try {
      const saved = JSON.parse(value) as Partial<Checkpoint>;
      if (saved.instance_id !== instanceId) throw new Error("Wrong instance");
      return { instance_id: instanceId, credit_id: hashSchema.parse(saved.credit_id) };
    } catch {
      throw new HedgeError(
        "JOURNAL_INVALID",
        "Saved loan is invalid. Recover its loan ID before borrowing again.",
      );
    }
  };
  return { journal, restore };
}
