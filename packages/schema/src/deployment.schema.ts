import { z } from "zod";
export const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
export const hashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
export const idSchema = z.string().min(1).max(256);
export const accountIdSchema = z.string().regex(/^0\.0\.[0-9]+$/);
const selector = z.string().regex(/^[1-9][0-9]*$/);
// Zero is full finality; only currently activated block-depth settings are admitted.
const finality = z.string().regex(/^0x0000[0-9a-fA-F]{4}$/);
const chain = z.strictObject({
  chain_id: z.number().int().positive(),
  router: addressSchema,
  selector,
  contract: addressSchema,
  code_hash: hashSchema,
  ccip_policy: z
    .strictObject({ requested_finality: finality, allowed_finality: finality })
    .optional(),
});
export const deploymentSchema = z
  .strictObject({
    schema_version: z.literal(1),
    instance_id: idSchema,
    build_id: idSchema,
    protocol_version: z.union([z.literal(2), z.literal(3)]),
    deployer: addressSchema,
    hedera: chain.extend({ contract_id: accountIdSchema }),
    base: chain,
  })
  .superRefine((value, context) => {
    if (
      value.hedera.selector === value.base.selector ||
      value.hedera.chain_id === value.base.chain_id
    )
      context.addIssue({
        code: "custom",
        message: "Hedera and Base must identify distinct chains",
      });
    const hedera = value.hedera.ccip_policy,
      base = value.base.ccip_policy;
    if (!!hedera !== !!base)
      context.addIssue({ code: "custom", message: "Declare CCIP policy on both chains" });
    if (hedera && base) {
      for (const [requested, allowed] of [
        [hedera.requested_finality, base.allowed_finality],
        [base.requested_finality, hedera.allowed_finality],
      ]) {
        const depth = Number.parseInt(requested.slice(2), 16);
        const minimum = Number.parseInt(allowed.slice(2), 16);
        if (depth !== 0 && (minimum === 0 || depth < minimum))
          context.addIssue({
            code: "custom",
            message: "CCIP sender and receiver policies do not match",
          });
      }
    }
  });
export type DeploymentManifest = z.infer<typeof deploymentSchema>;
