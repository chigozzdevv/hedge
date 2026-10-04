import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const path =
  process.env["HEDGE_ENV_FILE"] ?? fileURLToPath(new URL("../../../../.env", import.meta.url));
if (existsSync(path)) process.loadEnvFile(path);
