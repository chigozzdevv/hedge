import { z } from "zod";
import { addressSchema, hashSchema } from "@hedge/schema";

export const observationSchema = z.strictObject({
  chainId: z.number().int().positive(),
  contract: addressSchema.transform((value) => value.toLowerCase()),
  observedBlock: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  observedHash: hashSchema.transform((value) => value.toLowerCase()),
});
export type ChainObservation<T> = z.infer<typeof observationSchema> & { data: T };
