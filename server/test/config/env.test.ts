import { afterEach, describe, expect, it, vi } from "vitest";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});
describe("Hedge server settings", () => {
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
