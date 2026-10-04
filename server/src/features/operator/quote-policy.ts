import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { addressSchema } from "@hedge/schema";
import { sameAddress, type EvmTerms } from "@hedge/sdk";
import { keccak256, parseUnits, stringToHex } from "viem";

const decimal = (precision: number) =>
  z
    .string()
    .max(80)
    .regex(new RegExp(`^(0|[1-9]\\d*)(?:\\.\\d{1,${precision}})?$`));
const borrowerAddress = addressSchema.refine(
  (value) => !/^0x0{40}$/i.test(value),
  "Use a nonzero borrower address",
);
const basis = 10_000n;
const maxRepayment = (1n << 63n) - 1n;
const maxCollateral = (1n << 256n) - 1n;
const ceilDivide = (value: bigint, divisor: bigint) => (value + divisor - 1n) / divisor;
const asset = z.strictObject({
  chain_id: z.number().int().positive(),
  symbol: z.literal("USDC"),
  address: borrowerAddress,
});
function quoteAmounts(principal: bigint, ratio: bigint, charge: bigint) {
  const repaymentAmount = principal + ceilDivide(principal * charge, basis);
  const collateralAmount = ceilDivide(principal * ratio, basis);
  if (
    principal <= 0n ||
    ratio <= 0n ||
    repaymentAmount > maxRepayment ||
    collateralAmount > maxCollateral
  )
    throw new Error("Operator policy exceeds contract amount limits");
  return { repaymentAmount, collateralAmount };
}
export const operatorPolicySchema = z
  .strictObject({
    loan_asset: asset,
    accepted_collateral: asset,
    max_loan_amount: decimal(6),
    collateral_ratio: decimal(4),
    financing_charge_percent: decimal(2),
    term_days: z
      .number()
      .int()
      .positive()
      .max(Math.floor(0xffffffff / 86400)),
    repay_with_collateral: z.boolean().default(false),
    eligible_borrowers: z
      .array(borrowerAddress)
      .max(1000)
      .refine(
        (values) => new Set(values.map((value) => value.toLowerCase())).size === values.length,
        "Remove duplicate borrowers",
      )
      .default([]),
  })
  .superRefine((config, context) => {
    try {
      quoteAmounts(
        parseUnits(config.max_loan_amount, 6),
        parseUnits(config.collateral_ratio, 4),
        parseUnits(config.financing_charge_percent, 2),
      );
    } catch {
      context.addIssue({
        code: "custom",
        message: "Use positive loan/collateral amounts within contract limits",
      });
    }
  });
export type OperatorPolicy = z.infer<typeof operatorPolicySchema>;
type QuoteTerms = Pick<
  EvmTerms,
  | "principal"
  | "repaymentAmount"
  | "collateralAmount"
  | "duration"
  | "gracePeriod"
  | "policyHash"
  | "collateralRepaymentAmount"
>;

export async function loadOperatorPolicy(root: string): Promise<OperatorPolicy> {
  const path = resolve(root, process.env["HEDGE_POLICY_FILE"] || ".hedge/operator.json");
  return operatorPolicySchema.parse(JSON.parse(await readFile(path, "utf8")));
}

/** The loopback instance lends USDC against Base USDC; both use six decimals. */
export function compileQuotePolicy(value: unknown) {
  const config = operatorPolicySchema.parse(value);
  const maxPrincipal = parseUnits(config.max_loan_amount, 6);
  const ratio = parseUnits(config.collateral_ratio, 4);
  const charge = parseUnits(config.financing_charge_percent, 2);
  const eligible = config.eligible_borrowers.map((value) => value.toLowerCase()).sort();
  const duration = config.term_days * 86400;
  const policyHash = keccak256(
    stringToHex(
      JSON.stringify({
        max_principal: String(maxPrincipal),
        collateral_ratio_bps: String(ratio),
        financing_charge_bps: String(charge),
        duration,
        eligible_borrowers: eligible,
        repay_with_collateral: config.repay_with_collateral,
      }),
    ),
  );
  const quote = (principal: bigint): QuoteTerms => {
    if (principal <= 0n || principal > maxPrincipal)
      throw new Error("Amount exceeds operator loan policy");
    const amounts = quoteAmounts(principal, ratio, charge);
    if (config.repay_with_collateral && amounts.repaymentAmount > amounts.collateralAmount)
      throw new Error("Collateral must cover the agreed Base repayment amount");
    return {
      principal,
      ...amounts,
      collateralRepaymentAmount: config.repay_with_collateral ? amounts.repaymentAmount : 0n,
      duration,
      gracePeriod: 0,
      policyHash,
    };
  };
  const maximum = quote(maxPrincipal);
  return {
    maxPrincipal,
    maxRepayment: maximum.repaymentAmount,
    maxCollateral: maximum.collateralAmount,
    eligible: (address: string) =>
      borrowerAddress.safeParse(address).success &&
      (eligible.length === 0 || eligible.some((value) => sameAddress(value, address))),
    quote,
    matches(terms: QuoteTerms): boolean {
      if (terms.principal <= 0n || terms.principal > maxPrincipal) return false;
      const expected = quote(terms.principal);
      return (
        terms.repaymentAmount === expected.repaymentAmount &&
        terms.collateralAmount === expected.collateralAmount &&
        (terms.collateralRepaymentAmount ?? 0n) === expected.collateralRepaymentAmount &&
        terms.duration === expected.duration &&
        terms.gracePeriod === expected.gracePeriod &&
        terms.policyHash === expected.policyHash
      );
    },
  };
}
