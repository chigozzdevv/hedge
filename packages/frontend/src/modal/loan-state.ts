import type { CreditSummary } from "@hedge/sdk";

export function isLoanComplete(summary?: CreditSummary): boolean {
  if (!summary) return false;
  return (
    (summary.state === "repaid" && ["returned", "settled"].includes(summary.collateral_state)) ||
    (summary.state === "cancelled" &&
      ["returned", "unlocked"].includes(summary.collateral_state)) ||
    (summary.state === "defaulted" && summary.collateral_state === "recovered")
  );
}
