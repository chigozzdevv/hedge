import { z } from "zod";
import type { Hex } from "viem";

const hex = z
  .string()
  .regex(/^0x[\da-fA-F]+$/)
  .transform((value) => value as Hex);
export const liquidityJournalSchema = z.strictObject({
  version: z.literal(1),
  id: z.uuid(),
  instance: z.string(),
  operator: z.string(),
  token: z.string(),
  action: z.enum(["deposit", "withdraw"]),
  amount: z.string().regex(/^[1-9]\d*$/),
  status: z.enum(["pending", "complete", "failed"]),
  calls: z.array(z.strictObject({ to: hex, data: hex, serialized: hex, hash: hex })).max(3),
  hashes: z.record(z.string(), hex),
});
export type LiquidityJournal = z.infer<typeof liquidityJournalSchema>;
export type LiquidityStore = {
  read(): Promise<LiquidityJournal | undefined>;
  save(journal: LiquidityJournal): Promise<void>;
  complete(journal: LiquidityJournal, status?: "complete" | "failed"): Promise<void>;
  assertOwned(): Promise<void>;
};
