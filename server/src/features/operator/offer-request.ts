import { z } from "zod";
import { addressSchema, loanRequestSchema } from "@hedge/schema";

const baseUnits = z
  .string()
  .regex(/^[1-9]\d{0,77}$/)
  .transform((value) => BigInt(value))
  .pipe(
    z
      .bigint()
      .positive()
      .max((1n << 256n) - 1n),
  );
export const offerRequest = z.strictObject({
  request: loanRequestSchema.extend({
    funding: loanRequestSchema.shape.funding.extend({ amount: baseUnits }),
    collateral: loanRequestSchema.shape.collateral
      .unwrap()
      .extend({ amount: baseUnits })
      .optional(),
  }),
  base_owner: addressSchema,
});
