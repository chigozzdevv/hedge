import { z } from "zod";
import { accountIdSchema, addressSchema, hashSchema, idSchema } from "./deployment.schema";
import { chainSchema } from "./wallet.schema";
export const fundingRequestSchema = z.strictObject({
  token: addressSchema,
  amount: z.bigint().positive(),
  recipient: z.strictObject({
    account_id: accountIdSchema,
    address: addressSchema,
  }),
});
export const loanRequestSchema = z.strictObject({
  funding: fundingRequestSchema,
  collateral: z
    .strictObject({
      chain_id: z.number().int().positive(),
      asset: addressSchema,
      amount: z.bigint().positive(),
    })
    .optional(),
  credit: z.strictObject({ duration: z.number().int().positive() }).optional(),
});
export const offerSchema = z.strictObject({
  id: idSchema,
  instance_id: idSchema,
  terms_hash: hashSchema,
  operator: addressSchema.refine(
    (value) => !/^0x0{40}$/i.test(value),
    "Offer operator must be nonzero",
  ),
  /** Canonical operator policy binding; required by the EVM adapter when publishing. */
  policy_hash: hashSchema.optional(),
  funding: fundingRequestSchema,
  repayment_amount: z.bigint().positive(),
  acceptance_deadline: z.number().int().positive(),
  setup_deadline: z.number().int().positive(),
  duration: z.number().int().positive(),
  grace_period: z.number().int().nonnegative(),
  collateral: z.strictObject({
    asset: addressSchema,
    amount: z.bigint().positive(),
    owner: addressSchema,
    return_recipient: addressSchema,
    recovery_recipient: addressSchema,
    repayment_amount: z.bigint().nonnegative().optional(),
  }),
});
export const transactionSchema = z.strictObject({
  chain: chainSchema,
  hash: idSchema,
  confirmed: z.literal(true),
});
export const fundingResultSchema = z.strictObject({
  instance_id: idSchema,
  credit_id: idSchema,
  offer_id: idSchema,
  agreement_hash: hashSchema,
  funding: fundingRequestSchema,
  transaction: transactionSchema.extend({ chain: z.literal("hedera") }),
});
export const creditSummarySchema = z.strictObject({
  instance_id: idSchema,
  credit_id: idSchema,
  agreement_hash: hashSchema,
  state: z.enum(["accepted", "funded", "repaid", "cancelled", "defaulted", "settling"]),
  collateral_state: z.enum([
    "unlocked",
    "locked",
    "return_pending",
    "return_authorized",
    "returned",
    "recovery_pending",
    "recovery_authorized",
    "recovered",
    "settlement_pending",
    "settlement_authorized",
    "settled",
  ]),
  amount_due: z.bigint().nonnegative(),
  payment_deadline: z.number().int().positive().nullable(),
});
export type FundingRequest = z.infer<typeof fundingRequestSchema>;
export type LoanRequest = z.infer<typeof loanRequestSchema>;
export type Offer = z.infer<typeof offerSchema>;
export type ConfirmedTransaction = z.infer<typeof transactionSchema>;
export type FundingResult = z.infer<typeof fundingResultSchema>;
export type CreditSummary = z.infer<typeof creditSummarySchema>;
