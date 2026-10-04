import { z } from "zod";
import { addressSchema, deploymentSchema } from "./deployment.schema";

const httpUrl = z.url().refine((value) => {
  const url = new URL(value);
  return (
    ["http:", "https:"].includes(url.protocol) &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash
  );
}, "Use a public HTTP(S) URL without credentials, query or fragment");
const block = z.string().regex(/^(0|[1-9][0-9]*)$/);

/** Public connection details only. Chain verification still establishes authority. */
export const clientConfigSchema = z.strictObject({
  schema_version: z.literal(1),
  deployment: deploymentSchema,
  operator: addressSchema.refine(
    (value) => !/^0x0{40}$/i.test(value),
    "Select a nonzero operator wallet",
  ),
  rpc: z.strictObject({ hedera: httpUrl, base: httpUrl }),
  start_block: z.strictObject({ hedera: block, base: block }),
  mirror_url: httpUrl,
  operator_url: httpUrl,
});
export type ClientConfig = z.infer<typeof clientConfigSchema>;

export const connectionConfigSchema = clientConfigSchema
  .pick({ operator: true, rpc: true, mirror_url: true, operator_url: true })
  .extend({ deployment_file: z.string().regex(/^deployments\/[a-zA-Z0-9_-]+\.json$/) });
export type ConnectionConfig = z.infer<typeof connectionConfigSchema>;
