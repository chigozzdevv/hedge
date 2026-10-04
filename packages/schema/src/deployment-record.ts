import { z } from "zod";
import { clientConfigSchema, connectionConfigSchema } from "./client-config";
import { addressSchema, hashSchema, idSchema } from "./deployment.schema";

const verification = z.strictObject({
  transaction_hash: hashSchema,
  receipt_status: z.literal(1),
  block_number: z.string().regex(/^(0|[1-9][0-9]*)$/),
  block_hash: hashSchema,
  contract: addressSchema,
  code_hash: hashSchema,
  instance_id: idSchema,
  compiled_runtime_matched: z.literal(true),
});

export const deploymentRecordSchema = clientConfigSchema
  .extend({
    verification: z.strictObject({
      verified_at: z.iso.datetime({ offset: true }),
      hedera: verification,
      base: verification,
    }),
  })
  .superRefine((record, context) => {
    for (const chain of ["hedera", "base"] as const) {
      const proof = record.verification[chain];
      const deployed = record.deployment[chain];
      if (
        proof.contract.toLowerCase() !== deployed.contract.toLowerCase() ||
        proof.code_hash.toLowerCase() !== deployed.code_hash.toLowerCase() ||
        proof.instance_id !== record.deployment.instance_id ||
        proof.block_number !== record.start_block[chain]
      )
        context.addIssue({ code: "custom", message: `${chain} deployment verification differs` });
    }
  });

/** Publish connection fields only; startup still verifies the actual deployed contracts. */
export const deploymentConfigSchema = deploymentRecordSchema.transform((record) =>
  clientConfigSchema.strip().parse(record),
);

export function resolveConnectionConfig(settings: unknown, deployment: unknown) {
  const connection = connectionConfigSchema.parse(settings);
  return clientConfigSchema.parse({
    ...deploymentConfigSchema.parse(deployment),
    operator: connection.operator,
    operator_url: connection.operator_url,
    rpc: connection.rpc,
    mirror_url: connection.mirror_url,
  });
}
