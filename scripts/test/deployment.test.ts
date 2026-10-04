import { testRecord } from "../../packages/schema/test/config-fixture.js";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deploymentKey, loadConfig, publishConfig, saveDeployment } from "../deployment.js";
import { loadHedgeConfig } from "@hedge/sdk";

const record = structuredClone(testRecord);
let root: string;
let deploymentPath: string;
let configPath: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hedge-deployment-"));
  deploymentPath = join(root, "deployments/testnet.json");
  configPath = join(root, "hedge.config.json");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("managed deployment and config publication", () => {
  it("publishes only connection fields during explicit deployment", async () => {
    saveDeployment(record, deploymentPath);
    expect(readdirSync(root)).toEqual(["deployments"]);
    const config = loadConfig(deploymentPath);
    publishConfig(config, configPath);
    const published = JSON.parse(readFileSync(configPath, "utf8"));
    const fetchRecord = async () => Response.json(record);
    expect(await loadHedgeConfig(published, fetchRecord)).toEqual(config);
    expect(published.deployment_file).toBe("deployments/testnet.json");
    expect(published).not.toHaveProperty("deployment");
    expect(published).not.toHaveProperty("verification");
    expect(readFileSync(deploymentPath, "utf8")).toContain('"verification"');
    expect(readdirSync(root)).toEqual(["deployments", "hedge.config.json"]);
  });

  it("rejects unverified or inconsistent records and preserves the prior public files", () => {
    saveDeployment(record, deploymentPath);
    const previous = readFileSync(deploymentPath, "utf8");
    publishConfig(loadConfig(deploymentPath), configPath);
    const published = readFileSync(configPath, "utf8");
    for (const candidate of [
      { ...record, private_key: "test-secret" },
      { ...record, deployment: { ...record.deployment, private_key: "test-secret" } },
      {
        ...record,
        verification: {
          ...record.verification,
          hedera: { ...record.verification.hedera, receipt_status: 0 },
        },
      },
      { ...record, start_block: { ...record.start_block, base: "2" } },
      {
        ...record,
        verification: {
          ...record.verification,
          base: { ...record.verification.base, contract: `0x${"0".repeat(40)}` },
        },
      },
    ]) {
      expect(() => saveDeployment(candidate, deploymentPath)).toThrow();
      expect(readFileSync(deploymentPath, "utf8")).toBe(previous);
      writeFileSync(deploymentPath, JSON.stringify(candidate));
      expect(() => loadConfig(deploymentPath)).toThrow();
      expect(readFileSync(configPath, "utf8")).toBe(published);
      writeFileSync(deploymentPath, previous);
    }
  });

  it("applies a public endpoint override without altering signer or contract identities", () => {
    const operatorUrl = "https://operator.example/hedge";
    saveDeployment(record, deploymentPath, operatorUrl);
    const config = loadConfig(deploymentPath);
    expect(config.operator_url).toBe(operatorUrl);
    expect(config.deployment).toEqual(record.deployment);
    expect(loadConfig(deploymentPath, "https://other.example").operator_url).toBe(
      "https://other.example",
    );
    const previous = readFileSync(deploymentPath, "utf8");
    publishConfig(config, configPath);
    const published = readFileSync(configPath, "utf8");
    for (const url of [
      "https://user:password@example.com",
      "https://example.com?session=test-secret",
      "https://example.com#test-secret",
    ]) {
      expect(() => saveDeployment(record, deploymentPath, url)).toThrow();
      expect(() => loadConfig(deploymentPath, url)).toThrow();
      expect(() => publishConfig({ ...config, operator_url: url }, configPath)).toThrow();
      expect(readFileSync(deploymentPath, "utf8")).toBe(previous);
      expect(readFileSync(configPath, "utf8")).toBe(published);
    }
    expect(() => publishConfig({ ...config, session: "test-secret" }, configPath)).toThrow();
    expect(readFileSync(configPath, "utf8")).toBe(published);
  });

  it("refuses symlinked output instead of overwriting another file", () => {
    const other = join(root, "other.json");
    const output = join(root, "output.json");
    writeFileSync(other, "keep");
    symlinkSync(other, output);
    expect(() => saveDeployment(record, output)).toThrow("symlinked");
    saveDeployment(record, deploymentPath);
    expect(() => publishConfig(loadConfig(deploymentPath), output)).toThrow("symlinked");
    expect(readFileSync(other, "utf8")).toBe("keep");
  });
});

it("selects an app operator without changing shared deployment authority", () => {
  const second = `0x${"9".repeat(40)}`;
  saveDeployment(record, deploymentPath);
  const config = loadConfig(deploymentPath, "https://other.example", second);
  expect(config.operator).toBe(second);
  expect(config.deployment).toEqual(record.deployment);
  expect(config.deployment.deployer).not.toBe(second);
  expect(() => loadConfig(deploymentPath, undefined, `0x${"0".repeat(40)}`)).toThrow();
});

it("uses fresh deployment journals when custom contract bytecode changes", () => {
  for (const [name, code] of [
    ["hedge-lending.sol/HedgeLending.json", "0x6000"],
    ["hedge-vault.sol/HedgeVault.json", "0x6001"],
  ]) {
    const path = join(root, "contracts/out", name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify({ bytecode: { object: code } }));
  }
  const first = deploymentKey(root);
  expect(deploymentKey(root)).toBe(first);
  writeFileSync(
    join(root, "contracts/out/hedge-lending.sol/HedgeLending.json"),
    JSON.stringify({ bytecode: { object: "0x6002" } }),
  );
  expect(deploymentKey(root)).not.toBe(first);
});
