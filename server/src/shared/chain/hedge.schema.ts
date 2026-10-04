import { z } from "zod";
import { idSchema, addressSchema, hashSchema, creditSummarySchema } from "@hedge/schema";

export const collateralSchema = z
  .strictObject({
    instance_id: idSchema,
    credit_id: idSchema,
    agreement_hash: hashSchema,
    lock_id: idSchema.nullable(),
    asset: addressSchema,
    amount: z.bigint().nonnegative(),
    owner: addressSchema,
    return_recipient: addressSchema,
    recovery_recipient: addressSchema,
    state: creditSummarySchema.shape.collateral_state,
  })
  .superRefine((value, context) => {
    if (value.state !== "unlocked" && (!value.lock_id || value.amount === 0n))
      context.addIssue({
        code: "custom",
        message: "Custody state requires a lock and pledged amount",
      });
  });
export const operatorSchema = z.strictObject({
  instance_id: idSchema,
  operator: addressSchema,
  token: addressSchema,
  free_capital: z.bigint().nonnegative(),
  reserved_capital: z.bigint().nonnegative(),
});
export type CollateralSummary = z.infer<typeof collateralSchema>;
export type OperatorSummary = z.infer<typeof operatorSchema>;
