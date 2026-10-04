import type { LoanRequest } from "./loan.schema";

export function offerAuthorizationMessage(input: {
  operator_url: string;
  instance_id: string;
  request: LoanRequest;
  base_owner: string;
  expires_at: number;
}): string {
  const request = input.request;
  return [
    "Authorize Hedge loan quote",
    `Service: ${input.operator_url}`,
    `Deployment: ${input.instance_id.toLowerCase()}`,
    `Hedera borrower: ${request.funding.recipient.address.toLowerCase()}`,
    `Hedera account: ${request.funding.recipient.account_id}`,
    `Loan asset: ${request.funding.token.toLowerCase()}`,
    `Loan amount (base units): ${request.funding.amount}`,
    `Base owner: ${input.base_owner.toLowerCase()}`,
    `Collateral: ${request.collateral ? `${request.collateral.chain_id}:${request.collateral.asset.toLowerCase()}:${request.collateral.amount}` : "operator policy"}`,
    `Duration: ${request.credit?.duration ?? "operator policy"}`,
    `Expires: ${input.expires_at}`,
    "This requests an offer. It does not transfer assets or accept a loan.",
  ].join("\n");
}
