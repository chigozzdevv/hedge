import { describe, expect, it } from "vitest";
import { deploymentSchema, fundingRequestSchema } from "../src";

const address = `0x${"1".repeat(40)}`;
const hash = `0x${"2".repeat(64)}`;
const chain = { chain_id: 296, router: address, selector: "1", contract: address, code_hash: hash };
const manifest = {
  schema_version: 1,
  instance_id: "fixture",
  build_id: "unit-test",
  protocol_version: 3,
  deployer: address,
  hedera: { ...chain, contract_id: "0.0.123" },
  base: { ...chain, chain_id: 84532, selector: "2" },
};
describe("public deployment boundary", () => {
  it("admits matched fast policies and rejects stranded or inactive configurations", () => {
    const full = "0x00000000",
      fast = "0x00000005";
    const configured = {
      ...manifest,
      hedera: {
        ...manifest.hedera,
        ccip_policy: { requested_finality: full, allowed_finality: fast },
      },
      base: { ...manifest.base, ccip_policy: { requested_finality: fast, allowed_finality: full } },
    };
    expect(deploymentSchema.parse(configured).base.ccip_policy?.requested_finality).toBe(fast);
    expect(() => deploymentSchema.parse({ ...configured, hedera: manifest.hedera })).toThrow();
    expect(() =>
      deploymentSchema.parse({
        ...configured,
        hedera: {
          ...configured.hedera,
          ccip_policy: { requested_finality: full, allowed_finality: full },
        },
      }),
    ).toThrow();
    expect(() =>
      deploymentSchema.parse({
        ...configured,
        base: {
          ...configured.base,
          ccip_policy: { requested_finality: "0x00010000", allowed_finality: full },
        },
      }),
    ).toThrow();
  });
  it("rejects signing secrets and undocumented nested configuration", () => {
    expect(() => deploymentSchema.parse({ ...manifest, private_key: "secret" })).toThrow();
    expect(() =>
      deploymentSchema.parse({ ...manifest, base: { ...manifest.base, key: "secret" } }),
    ).toThrow();
  });
  it("rejects colliding network or CCIP identities", () => {
    expect(() =>
      deploymentSchema.parse({ ...manifest, base: { ...manifest.base, selector: "1" } }),
    ).toThrow();
    expect(() =>
      deploymentSchema.parse({ ...manifest, base: { ...manifest.base, chain_id: 296 } }),
    ).toThrow();
  });
  it("requires positive integer base units and a Hedera recipient identity", () => {
    const request = { token: address, amount: 1n, recipient: { address, account_id: "0.0.456" } };
    expect(fundingRequestSchema.parse(request).amount).toBe(1n);
    expect(() => fundingRequestSchema.parse({ ...request, amount: 0n })).toThrow();
    expect(() => fundingRequestSchema.parse({ ...request, amount: 1.5 })).toThrow();
    expect(() => fundingRequestSchema.parse({ ...request, recipient: { address } })).toThrow();
  });
});
