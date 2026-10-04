import {
  fundingResultSchema,
  creditSummarySchema,
  offerSchema,
  transactionSchema,
  type DeploymentManifest,
  type FundingResult,
  type CreditSummary,
  type Offer,
  type ConfirmedTransaction,
  type FundingRequest,
  type Chain,
} from "@hedge/schema";
import type { HedgeAdapter } from "../types/adapter.types";
import { HedgeError } from "./hedge-error";
import { sameAddress } from "../evm/address";
export class ClientContext {
  private verification?: Promise<void>;
  constructor(
    readonly manifest: DeploymentManifest,
    readonly adapter: HedgeAdapter,
  ) {}
  ready(): Promise<void> {
    if (!this.verification)
      this.verification = Promise.resolve()
        .then(() => this.adapter.verifyDeployment(this.manifest))
        .catch((error: unknown) => {
          this.verification = undefined;
          throw error;
        });
    return this.verification;
  }
  instance(id: string): void {
    if (id !== this.manifest.instance_id)
      throw new HedgeError("INSTANCE_MISMATCH", "Result belongs to another deployment");
  }
  assertFunding(actual: FundingRequest, expected: FundingRequest): void {
    if (
      !sameAddress(actual.token, expected.token) ||
      actual.amount !== expected.amount ||
      actual.recipient.account_id !== expected.recipient.account_id ||
      !sameAddress(actual.recipient.address, expected.recipient.address)
    )
      throw new HedgeError("FUNDING_MISMATCH", "Funding does not match the reviewed request");
  }
  funding(value: FundingResult, creditId?: string): FundingResult {
    const result = fundingResultSchema.parse(value);
    this.instance(result.instance_id);
    if (creditId && result.credit_id !== creditId)
      throw new HedgeError("CREDIT_MISMATCH", "Result belongs to another loan");
    return result;
  }
  summary(value: CreditSummary, creditId: string): CreditSummary {
    const result = creditSummarySchema.parse(value);
    this.instance(result.instance_id);
    if (result.credit_id !== creditId)
      throw new HedgeError("CREDIT_MISMATCH", "Result belongs to another loan");
    return result;
  }
  offer(value: Offer): Offer {
    const offer = offerSchema.parse(value);
    this.instance(offer.instance_id);
    return offer;
  }
  transaction(value: ConfirmedTransaction, chain: Chain): ConfirmedTransaction {
    const result = transactionSchema.parse(value);
    if (result.chain !== chain)
      throw new HedgeError("CHAIN_MISMATCH", "Operation confirmed on the wrong chain");
    return result;
  }
}
