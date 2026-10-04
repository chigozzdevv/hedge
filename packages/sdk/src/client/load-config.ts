import {
  clientConfigSchema,
  connectionConfigSchema,
  resolveConnectionConfig,
  type ClientConfig,
  type ConnectionConfig,
} from "@hedge/schema";
import { HedgeError } from "./hedge-error";

/** A browser loads a public file; it cannot discover deployment files on disk. */
export async function loadHedgeConfig(
  source: string | ClientConfig | ConnectionConfig = "/hedge.config.json",
  request: typeof fetch = globalThis.fetch,
  signal?: AbortSignal,
): Promise<ClientConfig> {
  let value: unknown = source;
  if (typeof source === "string") {
    let response: Response;
    try {
      const options = { signal, cache: "no-store" as const };
      response = await request(source, options);
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new HedgeError("CONFIG_UNAVAILABLE", `Could not load Hedge config at ${source}`);
    }
    if (!response.ok)
      throw new HedgeError(
        response.status === 404 ? "CONFIG_MISSING" : "CONFIG_UNAVAILABLE",
        response.status === 404
          ? `Hedge config is missing at ${source}. Serve your Hedge public configuration.`
          : `Could not load Hedge config at ${source} (HTTP ${response.status})`,
      );
    try {
      value = await response.json();
    } catch {
      throw new HedgeError("CONFIG_INVALID", "Hedge config must contain valid JSON");
    }
  }
  const settings = connectionConfigSchema.safeParse(value);
  if (settings.success) {
    const configUrl = typeof source === "string" ? source : "/hedge.config.json";
    const url = new URL(settings.data.deployment_file, new URL(configUrl, "http://hedge.invalid"));
    const target = /^https?:\/\//.test(configUrl) ? url.href : url.pathname;
    let response: Response;
    try {
      const options = { signal, cache: "no-store" as const };
      response = await request(target, options);
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new HedgeError("CONFIG_UNAVAILABLE", "Could not load the configured deployment record");
    }
    if (!response.ok)
      throw new HedgeError(
        response.status === 404 ? "CONFIG_MISSING" : "CONFIG_UNAVAILABLE",
        "The configured deployment record is unavailable",
      );
    try {
      return resolveConnectionConfig(settings.data, await response.json());
    } catch {
      throw new HedgeError("CONFIG_INVALID", "The configured deployment record is invalid");
    }
  }
  const result = clientConfigSchema.safeParse(value);
  if (!result.success)
    throw new HedgeError(
      "CONFIG_INVALID",
      `Hedge config is incomplete or invalid: ${result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
    );
  return result.data;
}
