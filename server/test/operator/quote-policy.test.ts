import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  compileQuotePolicy,
  loadOperatorPolicy,
  operatorPolicySchema,
} from "../../src/features/operator/quote-policy.js";

const local = `0x${"1".repeat(40)}` as const;
const defaults = {
  loan_asset: {
    chain_id: 296,
    symbol: "USDC",
    address: "0x0000000000000000000000000000000000001549",
  },
  accepted_collateral: {
    chain_id: 84532,
    symbol: "USDC",
    address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  },
  max_loan_amount: "1",
  collateral_ratio: "2",
  financing_charge_percent: "2",
  term_days: 30,
  eligible_borrowers: [local],
};
const other = `0x${"2".repeat(40)}` as const;
afterEach(() => vi.unstubAllEnvs());

describe("operator quote policy", () => {
  it("enables a fixed Base USDC settlement only when the operator opts in", () => {
    const disabled = compileQuotePolicy(defaults).quote(500000n);
    expect(disabled.collateralRepaymentAmount).toBe(0n);
    const enabled = compileQuotePolicy({ ...defaults, repay_with_collateral: true });
    const terms = enabled.quote(500000n);
    expect(terms.collateralRepaymentAmount).toBe(510000n);
    expect(terms.collateralAmount - terms.collateralRepaymentAmount).toBe(490000n);
    expect(terms.policyHash).not.toBe(disabled.policyHash);
    expect(enabled.matches({ ...terms, collateralRepaymentAmount: 1n })).toBe(false);
    expect(() =>
      compileQuotePolicy({ ...defaults, repay_with_collateral: true, collateral_ratio: "1" }),
    ).toThrow("cover");
  });
  it("preserves the existing USDC economics and checks explicit borrower addresses", () => {
    const policy = compileQuotePolicy(defaults);
    expect(policy.eligible(local)).toBe(true);
    expect(policy.eligible(other)).toBe(false);
    expect(policy.quote(1_000_000n)).toMatchObject({
      principal: 1_000_000n,
      repaymentAmount: 1_020_000n,
      collateralAmount: 2_000_000n,
      duration: 30 * 86400,
      gracePeriod: 0,
    });
    expect(() => policy.quote(1_000_001n)).toThrow("policy");
    expect(() => policy.quote(0n)).toThrow("policy");
  });
  it("uses changed limits, ratio, charge, duration and allowlist without float arithmetic", () => {
    const policy = compileQuotePolicy({
      ...defaults,
      max_loan_amount: "5",
      collateral_ratio: "1.5",
      financing_charge_percent: "1.25",
      term_days: 7,
      eligible_borrowers: [other],
    });
    expect(policy.eligible(local)).toBe(false);
    expect(policy.eligible(other)).toBe(true);
    expect(policy.quote(3_000_000n)).toMatchObject({
      repaymentAmount: 3_037_500n,
      collateralAmount: 4_500_000n,
      duration: 7 * 86400,
    });
    expect(policy.quote(1n)).toMatchObject({ repaymentAmount: 2n, collateralAmount: 2n });
    expect(() => policy.quote(5_000_001n)).toThrow();
  });
  it("does not reuse an old open offer after a policy change", () => {
    const original = compileQuotePolicy(defaults);
    const accepted = original.quote(1_000_000n);
    expect(original.matches(accepted)).toBe(true);
    const revised = compileQuotePolicy({ ...defaults, max_loan_amount: "0.1" });
    expect(revised.matches(accepted)).toBe(false);
    expect(accepted.repaymentAmount).toBe(1_020_000n);
    expect(accepted.duration).toBe(30 * 86400);
    expect(original.matches({ ...accepted, repaymentAmount: 1_010_000n })).toBe(false);
  });
  it("opens eligibility with an empty list and normalizes equivalent policies", () => {
    const open = compileQuotePolicy({ ...defaults, eligible_borrowers: [] });
    expect(open.eligible(local)).toBe(true);
    expect(open.eligible(other)).toBe(true);
    expect(open.eligible("invalid")).toBe(false);
    expect(open.eligible(`0x${"0".repeat(40)}`)).toBe(false);
    const canonical = compileQuotePolicy(defaults).quote(1n);
    const equivalent = compileQuotePolicy({
      ...defaults,
      collateral_ratio: "2.0000",
      eligible_borrowers: [local],
    });
    expect(equivalent.quote(1n).policyHash).toBe(canonical.policyHash);
  });
  it("defaults to open eligibility when the list is omitted", () => {
    const withoutList: Record<string, unknown> = { ...defaults };
    delete withoutList.eligible_borrowers;
    const policy = compileQuotePolicy(withoutList);
    expect(policy.eligible(other)).toBe(true);
    expect(policy.quote(1n).policyHash).toBe(
      compileQuotePolicy({ ...defaults, eligible_borrowers: [] }).quote(1n).policyHash,
    );
  });
  it.each([
    { max_loan_amount: 1 },
    { max_loan_amount: "1e6" },
    { max_loan_amount: "01" },
    { max_loan_amount: "0" },
    { max_loan_amount: "0.0000001" },
    { max_loan_amount: "9223372036854.775808" },
    { collateral_ratio: "0" },
    { collateral_ratio: "1.00001" },
    { collateral_ratio: "9".repeat(80) },
    { financing_charge_percent: "-1" },
    { financing_charge_percent: "2.001" },
    { financing_charge_percent: "9".repeat(80) },
    { term_days: 0 },
    { term_days: 1.5 },
    { term_days: 49_711 },
    { eligible_borrowers: ["any"] },
    { eligible_borrowers: ["local-test-wallet"] },
    { eligible_borrowers: [`0x${"0".repeat(40)}`] },
    { eligible_borrowers: [local, local] },
    { private_key: "test-secret" },
  ])("rejects malformed or contract-incompatible settings %j", (change) => {
    expect(() => operatorPolicySchema.parse({ ...defaults, ...change })).toThrow();
  });
  it("loads a selected backend file and fails closed when missing/invalid", async () => {
    const root = mkdtempSync(join(tmpdir(), "hedge-policy-"));
    mkdirSync(join(root, ".hedge"));
    try {
      vi.stubEnv("HEDGE_POLICY_FILE", undefined);
      await expect(loadOperatorPolicy(root)).rejects.toThrow();
      writeFileSync(join(root, ".hedge/operator.json"), JSON.stringify(defaults));
      expect(await loadOperatorPolicy(root)).toEqual({ ...defaults, repay_with_collateral: false });
      writeFileSync(join(root, "selected.json"), JSON.stringify({ ...defaults, term_days: 7 }));
      vi.stubEnv("HEDGE_POLICY_FILE", "selected.json");
      expect((await loadOperatorPolicy(root)).term_days).toBe(7);
      writeFileSync(join(root, "selected.json"), "{");
      await expect(loadOperatorPolicy(root)).rejects.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
