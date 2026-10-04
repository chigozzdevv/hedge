import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { connectionConfigSchema, resolveConnectionConfig } from "@hedge/schema";
import { deploymentDirectory } from "./workspace.js";
import { sameAddress } from "@hedge/sdk";

export function loadPublicConfig(root: string) {
  const path = resolve(root, ".hedge/hedge.config.json");
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    throw new Error("Missing hedge.config.json; use the supplied server configuration");
  }
  const settings = connectionConfigSchema.parse(JSON.parse(contents));
  const deployment = JSON.parse(
    readFileSync(resolve(deploymentDirectory(root), settings.deployment_file), "utf8"),
  );
  const config = resolveConnectionConfig(settings, deployment);
  for (const [name, matches] of [
    ["HEDGE_OPERATOR_ADDRESS", (value: string) => sameAddress(value, config.operator)],
    ["HEDGE_OPERATOR_URL", (value: string) => value === config.operator_url],
  ] as const) {
    const value = process.env[name];
    if (value && !matches(value))
      throw new Error(`Remove ${name} from .env; configure it in hedge.config.json`);
  }
  return config;
}
