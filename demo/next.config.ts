import type { NextConfig } from "next";

const config: NextConfig = {
  agentRules: false,
  poweredByHeader: false,
  transpilePackages: ["@hedge/frontend", "@hedge/sdk", "@hedge/schema", "@hedge/bindings"],
};

export default config;
