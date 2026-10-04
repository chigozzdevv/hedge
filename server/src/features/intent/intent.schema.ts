import { loanRequestSchema } from "@hedge/schema";
import { z } from "zod";

const amount = z
  .string()
  .regex(/^[1-9][0-9]{0,77}$/)
  .transform((value) => BigInt(value));
/** HTTP input maps decimal-string amounts into the shared SDK request schema. */
export const intentSchema = z
  .strictObject({
    funding: z.strictObject({
      token: z.string(),
      amount,
      recipient: z.strictObject({ account_id: z.string(), address: z.string() }),
    }),
    collateral: z
      .strictObject({ chain_id: z.number().int(), asset: z.string(), amount })
      .optional(),
    credit: z.strictObject({ duration: z.number().int() }).optional(),
  })
  .pipe(loanRequestSchema);
