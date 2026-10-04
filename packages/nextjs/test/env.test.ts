import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("shared website environment", () => {
  it("derives public URLs from shared service ports without exposing database settings", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hedge-website-env-"));
    const path = join(directory, ".env");
    try {
      writeFileSync(
        path,
        "PORT=3403\nFRONTEND_PORT=3402\nDATABASE_URL=postgresql://operator:test@db/hedge\n",
      );
      vi.stubEnv("HEDGE_ENV_FILE", path);
      for (const key of [
        "PORT",
        "FRONTEND_PORT",
        "DATABASE_URL",
        "NEXT_PUBLIC_HEDGE_SERVER",
        "NEXT_PUBLIC_SITE_URL",
      ])
        vi.stubEnv(key, undefined);
      const { default: config } = await import("../next.config.js");
      expect(process.env["NEXT_PUBLIC_HEDGE_SERVER"]).toBe("http://127.0.0.1:3403");
      expect(process.env["NEXT_PUBLIC_SITE_URL"]).toBe("http://127.0.0.1:3402");
      expect(config.env).toBeUndefined();
    } finally {
      rmSync(directory, { recursive: true });
    }
  });
  it("preserves explicitly configured public URLs", async () => {
    vi.stubEnv("HEDGE_ENV_FILE", join(tmpdir(), "hedge-env-does-not-exist"));
    vi.stubEnv("NEXT_PUBLIC_HEDGE_SERVER", "https://operator.example");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://app.example");
    await import("../next.config.js");
    expect(process.env["NEXT_PUBLIC_HEDGE_SERVER"]).toBe("https://operator.example");
    expect(process.env["NEXT_PUBLIC_SITE_URL"]).toBe("https://app.example");
  });
});
