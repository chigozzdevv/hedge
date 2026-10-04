import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { deploymentConfigSchema, type ClientConfig } from "@hedge/schema";
import { createAccountResolver, EvmHedgeReader, sameAddress } from "@hedge/sdk";
import type { LocalTestSigner } from "../../shared/chain/local-signer.js";
import { createCcipRelay } from "./ccip-relay.js";

/** Keep the previous immutable pair usable for accepted loans; new offers stay on the active pair. */
export async function createLegacyRelay(
  root: string,
  active: ClientConfig,
  signer: LocalTestSigner,
) {
  let contents: string;
  try {
    contents = await readFile(resolve(root, ".hedge/legacy/v2/testnet.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const config = deploymentConfigSchema.parse(JSON.parse(contents));
  if (config.deployment.instance_id === active.deployment.instance_id) return undefined;
  if (config.deployment.protocol_version !== 2 || !sameAddress(config.operator, active.operator))
    throw new Error("Legacy deployment must belong to the same operator and protocol v2");
  const reader = new EvmHedgeReader({
    manifest: config.deployment,
    rpc: config.rpc,
    startBlock: {
      hedera: BigInt(config.start_block.hedera),
      base: BigInt(config.start_block.base),
    },
    resolveAccount: createAccountResolver(config.mirror_url),
  });
  await reader.verifyDeployment();
  return { config, reader, relay: createCcipRelay(reader, signer) };
}
