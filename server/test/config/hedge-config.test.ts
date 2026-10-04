import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testConfig, testRecord } from "../../../packages/schema/test/config-fixture.js";
import { loadPublicConfig } from "../../src/shared/config/hedge-config.js";

const settings = {
  deployment_file: "deployments/testnet.json",
  operator: testConfig.operator,
  rpc: testConfig.rpc,
  mirror_url: testConfig.mirror_url,
  operator_url: testConfig.operator_url,
};
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hedge-public-config-"));
  mkdirSync(join(root, "deployments"));
  mkdirSync(join(root, ".hedge"));
  writeFileSync(join(root, "deployments/testnet.json"), JSON.stringify(testRecord));
  vi.stubEnv("HEDGE_OPERATOR_ADDRESS", undefined);
  vi.stubEnv("HEDGE_OPERATOR_URL", undefined);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
describe("supplied server configuration", () => {
  it("reads platform edits without changing the supplied file or deployment record", () => {
    const config = {
      ...settings,
      operator: `0x${"9".repeat(40)}`,
      operator_url: "https://my-app.example/hedge",
    };
    const contents = JSON.stringify(config, null, 4);
    writeFileSync(join(root, ".hedge/hedge.config.json"), contents);
    expect(loadPublicConfig(root)).toEqual({
      ...testConfig,
      operator: config.operator,
      operator_url: config.operator_url,
    });
    expect(readFileSync(join(root, ".hedge/hedge.config.json"), "utf8")).toBe(contents);
  });
  it("fails explicitly for a missing configuration instead of creating one", () => {
    expect(() => loadPublicConfig(root)).toThrow("Missing hedge.config.json");
  });
  it("rejects private deployment paths and inconsistent deployment evidence", () => {
    const path = join(root, ".hedge/hedge.config.json");
    writeFileSync(path, JSON.stringify({ ...settings, deployment_file: ".hedge/wallets.json" }));
    expect(() => loadPublicConfig(root)).toThrow();
    writeFileSync(path, JSON.stringify(settings));
    writeFileSync(
      join(root, "deployments/testnet.json"),
      JSON.stringify({ ...testRecord, start_block: { ...testRecord.start_block, base: "99" } }),
    );
    expect(() => loadPublicConfig(root)).toThrow();
  });
  it("rejects credentials and conflicting legacy environment overrides", () => {
    const path = join(root, ".hedge/hedge.config.json");
    writeFileSync(path, JSON.stringify({ ...settings, private_key: "example" }));
    expect(() => loadPublicConfig(root)).toThrow();
    writeFileSync(path, JSON.stringify(settings));
    vi.stubEnv("HEDGE_OPERATOR_ADDRESS", `0x${"9".repeat(40)}`);
    expect(() => loadPublicConfig(root)).toThrow("Remove HEDGE_OPERATOR_ADDRESS");
    vi.stubEnv("HEDGE_OPERATOR_ADDRESS", testConfig.operator);
    vi.stubEnv("HEDGE_OPERATOR_URL", "https://other.example");
    expect(() => loadPublicConfig(root)).toThrow("Remove HEDGE_OPERATOR_URL");
  });
});
