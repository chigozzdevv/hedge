import type { NextConfig } from "next";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const path = process.env["HEDGE_ENV_FILE"] ?? resolve(process.cwd(), "../../.env");
if (existsSync(path)) process.loadEnvFile(path);

process.env["NEXT_PUBLIC_SITE_URL"] ||=
  `http://127.0.0.1:${process.env["FRONTEND_PORT"] || "3002"}`;

const config: NextConfig = {
  agentRules: false,
  poweredByHeader: false,
  outputFileTracingRoot: resolve(process.cwd(), "../.."),
  outputFileTracingIncludes: {
    "/hedge.config.json": [".hedge/hedge.config.json", "../../deployments/testnet.json"],
  },
  outputFileTracingExcludes: {
    "/*": [".hedge/wallets.json", "../../.env"],
  },
  transpilePackages: ["@hedge/frontend", "@hedge/sdk", "@hedge/schema", "@hedge/bindings"],
};

export default config;
