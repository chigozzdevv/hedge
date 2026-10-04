import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});
describe("Hedge server settings", () => {
  it("loads the selected shared env file before server settings without replacing shell values", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hedge-env-"));
    const path = join(directory, ".env");
    try {
      writeFileSync(
        path,
        "PORT=3403\nDATABASE_DRIVER=postgres\nDATABASE_URL=postgresql://operator:test@db/hedge\n",
      );
      vi.stubEnv("HEDGE_ENV_FILE", path);
      vi.stubEnv("PORT", "3303");
      vi.stubEnv("DATABASE_DRIVER", undefined);
      vi.stubEnv("DATABASE_URL", undefined);
      await import("../../src/shared/config/load-env.js");
      const { env } = await import("../../src/shared/config/env.js");
      expect(env.port).toBe(3303);
      expect(env.databaseDriver).toBe("postgres");
      expect(env.databaseUrl).toBe("postgresql://operator:test@db/hedge");
    } finally {
      rmSync(directory, { recursive: true });
    }
  });
  it("needs no legacy contract, chain, signer or storage for health-only startup", async () => {
    for (const key of [
      "PORT",
      "HOST",
      "DATABASE_DRIVER",
      "DATABASE_URL",
      "MONGO_URL",
      "REDIS_URL",
      "REDIS_PREFIX",
      "CORS_ORIGINS",
    ])
      vi.stubEnv(key, undefined);
    const { env, assertServerConfig } = await import("../../src/shared/config/env.js");
    expect(assertServerConfig).not.toThrow();
    expect(env.redisPrefix).toBe("hedge");
    expect(env.databaseDriver).toBe("none");
    expect(env.databaseUrl).toBe("");
  });
  it.each([
    ["PORT", "65536"],
    ["PORT", "NaN"],
    ["MONGO_URL", "https://example.com"],
    ["DATABASE_DRIVER", "other"],
    ["DATABASE_DRIVER", "postgres"],
    ["DATABASE_URL", "postgresql://secret@localhost/hedge"],
    ["REDIS_URL", "file:///tmp/redis"],
    ["REDIS_PREFIX", "other:protocol"],
    ["CORS_ORIGINS", "https://app.example/path"],
  ])("rejects invalid %s without exposing its value", async (key, value) => {
    vi.stubEnv(key, value);
    const { assertServerConfig } = await import("../../src/shared/config/env.js");
    expect(assertServerConfig).toThrow();
  });
  it.each([
    ["mongodb", "mongodb://127.0.0.1:27017/hedge"],
    ["mongodb", "mongodb://one:27017,two:27017/hedge?replicaSet=hedge"],
    ["mongodb", "mongodb+srv://operator:secret@cluster.example/hedge"],
    ["postgres", "postgresql://operator:secret@127.0.0.1:5432/hedge"],
  ])("accepts a configured %s database", async (driver, url) => {
    vi.stubEnv("DATABASE_DRIVER", driver);
    vi.stubEnv("DATABASE_URL", url);
    const { assertServerConfig } = await import("../../src/shared/config/env.js");
    expect(assertServerConfig).not.toThrow();
  });
  it.each([
    ["mongodb", "postgresql://operator:secret@localhost/hedge"],
    ["postgres", "mongodb://operator:secret@localhost/hedge"],
    ["postgres", "postgresql://operator:secret@localhost"],
  ])("rejects a mismatched database URI without exposing credentials", async (driver, url) => {
    vi.stubEnv("DATABASE_DRIVER", driver);
    vi.stubEnv("DATABASE_URL", url);
    const { assertServerConfig } = await import("../../src/shared/config/env.js");
    expect(assertServerConfig).toThrow();
    try {
      assertServerConfig();
    } catch (error) {
      expect(String(error)).not.toContain("secret");
    }
  });
});
