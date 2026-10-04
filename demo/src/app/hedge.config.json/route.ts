import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { connectionConfigSchema, resolveConnectionConfig } from "@hedge/schema";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const headers = { "Cache-Control": "no-store" };
  try {
    const root = resolve(process.env["HEDGE_APP_DIR"] || process.cwd());
    const deploymentRoot = resolve(process.env["HEDGE_DEPLOYMENT_ROOT"] || resolve(root, ".."));
    const settings = connectionConfigSchema.parse(
      JSON.parse(await readFile(resolve(root, ".hedge/hedge.config.json"), "utf8")),
    );
    const record = JSON.parse(
      await readFile(resolve(deploymentRoot, settings.deployment_file), "utf8"),
    );
    return Response.json(resolveConnectionConfig(settings, record), { headers });
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    return Response.json(
      { error: missing ? "hedge-config-missing" : "hedge-config-invalid" },
      { status: missing ? 404 : 503, headers },
    );
  }
}
