import { z } from "zod";
import { accountIdSchema, addressSchema } from "./deployment.schema";

export const chainSchema = z.enum(["hedera", "base"]);
export const walletIdentitySchema = z.strictObject({
  chain_id: z.number().int().positive(),
  address: addressSchema,
  account_id: accountIdSchema.optional(),
});
export const tokenMetadataSchema = z.strictObject({
  chain_id: z.number().int().positive(),
  address: addressSchema,
  symbol: z.string().trim().min(1).max(32),
  decimals: z.number().int().min(0).max(77),
});
export type Chain = z.infer<typeof chainSchema>;
export type WalletIdentity = z.infer<typeof walletIdentitySchema>;
export type TokenMetadata = z.infer<typeof tokenMetadataSchema>;
