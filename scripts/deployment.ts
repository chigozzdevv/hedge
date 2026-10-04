import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  clientConfigSchema,
  connectionConfigSchema,
  deploymentConfigSchema,
  deploymentRecordSchema,
} from "@hedge/schema";

function writeJson(path: string, value: unknown, mode: number): void {
  if (existsSync(path) && lstatSync(path).isSymbolicLink())
    throw new Error("Refusing symlinked deployment/config output");
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function loadConfig(path: string, operatorUrl?: string, operator?: string) {
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (![2, 3].includes(value.deployment?.protocol_version))
    throw new Error(
      "Shared operator contracts require a v2 or v3 deployment. The existing v1 contracts remain unchanged.",
    );
  const config = deploymentConfigSchema.parse(value);
  if (operatorUrl) config.operator_url = clientConfigSchema.shape.operator_url.parse(operatorUrl);
  if (operator) config.operator = clientConfigSchema.shape.operator.parse(operator);
  return config;
}

export function saveDeployment(value: unknown, path: string, operatorUrl?: string): void {
  const record = deploymentRecordSchema.parse(value);
  if (operatorUrl) record.operator_url = clientConfigSchema.shape.operator_url.parse(operatorUrl);
  writeJson(path, record, 0o644);
}

/** Explicit deployment updates public contract details; startup only reads them. */
export function publishConfig(value: unknown, path: string): void {
  const config = clientConfigSchema.parse(value);
  writeJson(
    path,
    connectionConfigSchema.parse({
      deployment_file: "deployments/testnet.json",
      operator: config.operator,
      operator_url: config.operator_url,
      rpc: config.rpc,
      mirror_url: config.mirror_url,
    }),
    0o644,
  );
}

/** Changed contract bytecode gets fresh journals; prior deployments remain recoverable. */
export function deploymentKey(root: string): string {
  const creation = ["hedge-lending.sol/HedgeLending.json", "hedge-vault.sol/HedgeVault.json"].map(
    (path) => {
      const artifact = JSON.parse(readFileSync(join(root, "packages/foundry/out", path), "utf8"));
      if (
        typeof artifact.bytecode?.object !== "string" ||
        !/^0x[0-9a-fA-F]+$/.test(artifact.bytecode.object)
      )
        throw new Error("Build real contract artifacts before deploying");
      return artifact.bytecode.object;
    },
  );
  const key = createHash("sha256")
    .update(`hedge-v3:${creation.join(":")}`)
    .digest("hex")
    .slice(0, 16);
  return key;
}
