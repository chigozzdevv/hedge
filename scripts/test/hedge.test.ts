import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadEnvironment, main, managerConfig, ownedProcess } from "../hedge.js";

const directory = mkdtempSync(join(tmpdir(), "hedge-manager-test-"));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("platform management configuration", () => {
  it("loads private env configuration while preserving explicit environment overrides", () => {
    const path = join(directory, "operator.env");
    writeFileSync(path, 'HEDGE_TEST_VALUE="from file"\nHEDGE_TEST_OVERRIDE=from-file\n', {
      mode: 0o600,
    });
    vi.stubEnv("HEDGE_TEST_VALUE", undefined);
    vi.stubEnv("HEDGE_TEST_OVERRIDE", "explicit");
    loadEnvironment(path);
    expect(process.env["HEDGE_TEST_VALUE"]).toBe("from file");
    expect(process.env["HEDGE_TEST_OVERRIDE"]).toBe("explicit");
  });
  it("pins the browser URL and origin to the configured backend and frontend ports", () => {
    vi.stubEnv("PORT", "3303");
    vi.stubEnv("FRONTEND_PORT", "3302");
    vi.stubEnv("CORS_ORIGINS", "");
    const config = managerConfig();
    expect(config.environment["NEXT_PUBLIC_HEDGE_SERVER"]).toBe("http://127.0.0.1:3303");
    expect(config.environment["CORS_ORIGINS"]).toBe("http://127.0.0.1:3302");
  });
  it("does not overwrite a supplied operator endpoint for local mode", () => {
    vi.stubEnv("HEDGE_LOCAL_TESTNET", "1");
    vi.stubEnv("PORT", "3303");
    vi.stubEnv("HEDGE_OPERATOR_URL", "http://127.0.0.1:3303/testnet");
    expect(managerConfig().environment["HEDGE_OPERATOR_URL"]).toBe("http://127.0.0.1:3303/testnet");
  });
  it("changes the configuration fingerprint when the database or queue namespace changes", () => {
    vi.stubEnv("DATABASE_DRIVER", "postgres");
    vi.stubEnv("DATABASE_URL", "postgresql://operator:private@db/hedge");
    const first = managerConfig().configHash;
    vi.stubEnv("DATABASE_URL", "postgresql://operator:other@db/hedge");
    expect(managerConfig().configHash).not.toBe(first);
    expect(managerConfig().configHash).not.toContain("private");
    const second = managerConfig().configHash;
    vi.stubEnv("REDIS_PREFIX", "hedge-other");
    expect(managerConfig().configHash).not.toBe(second);
  });
  it("loads the single deployment record by default", () => {
    vi.stubEnv("HEDGE_DEPLOYMENT_FILE", undefined);
    expect(managerConfig().environment["HEDGE_DEPLOYMENT_FILE"]).toBe("deployments/testnet.json");
  });
  it("requires restart when the selected operator policy changes", () => {
    const path = join(directory, "operator.json");
    vi.stubEnv("HEDGE_POLICY_FILE", path);
    writeFileSync(path, JSON.stringify({ max_loan_amount: "1" }));
    const first = managerConfig();
    expect(first.environment["HEDGE_POLICY_FILE"]).toBe(path);
    writeFileSync(path, JSON.stringify({ max_loan_amount: "2" }));
    expect(managerConfig().configHash).not.toBe(first.configHash);
  });
  it("uses the app operator policy by default", () => {
    vi.stubEnv("HEDGE_POLICY_FILE", undefined);
    expect(managerConfig().environment["HEDGE_POLICY_FILE"]).toBe(".hedge/operator.json");
  });
  it("requires restart when the supplied public configuration is edited", () => {
    mkdirSync(join(directory, ".hedge"), { recursive: true });
    const path = join(directory, ".hedge/hedge.config.json");
    writeFileSync(path, JSON.stringify({ operator_url: "https://first.example" }));
    const first = managerConfig(directory).configHash;
    writeFileSync(path, JSON.stringify({ operator_url: "https://second.example" }));
    expect(managerConfig(directory).configHash).not.toBe(first);
  });
  it.each([
    ["PORT", "0"],
    ["PORT", "abc"],
    ["FRONTEND_PORT", "3003"],
  ])("rejects invalid %s configuration", (key, value) => {
    vi.stubEnv("PORT", "3003");
    vi.stubEnv("FRONTEND_PORT", "3002");
    vi.stubEnv(key, value);
    expect(() => managerConfig()).toThrow();
  });
  it("refuses publicly bound local wallet services", () => {
    vi.stubEnv("HEDGE_LOCAL_TESTNET", "1");
    vi.stubEnv("HOST", "0.0.0.0");
    expect(() => managerConfig()).toThrow("loopback");
  });
  it("does not claim an unrelated live PID as a managed service", () => {
    expect(
      ownedProcess({
        pid: process.pid,
        runId: "a".repeat(36),
        configHash: "a".repeat(64),
        port: 3303,
        url: "http://127.0.0.1:3303",
      }),
    ).toBe(false);
  });
  it("rejects hidden runner requests and extra deployment arguments before starting anything", async () => {
    await expect(main(["internal", "server", "invalid"])).rejects.toThrow(
      "Invalid managed service invocation",
    );
    await expect(main(["deploy", "mainnet"])).rejects.toThrow("Configure deployment");
    await expect(main(["missing"])).rejects.toThrow("Unknown command");
    rmSync(directory, { recursive: true });
  });
});
