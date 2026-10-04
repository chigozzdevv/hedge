import type {
  DeploymentManifest,
  LoanRequest,
  Offer,
  FundingResult,
  CreditSummary,
  ConfirmedTransaction,
  TokenMetadata,
} from "@hedge/schema";
export interface Checkpoint {
  instance_id: string;
  credit_id: string;
  stage: string;
  transaction?: ConfirmedTransaction;
}
export interface OperationOptions {
  on_progress?: (checkpoint: Checkpoint) => void;
}
export interface AcceptOptions extends OperationOptions {
  offer_id: string;
  reviewedOffer: Offer;
}
export interface Activity {
  stage: string;
  transaction?: ConfirmedTransaction;
}
export interface CollateralStatus {
  state: CreditSummary["collateral_state"];
}
export interface OperatorSummary {
  instance_id: string;
  operator: string;
  free_capital: bigint;
  reserved_capital: bigint;
}
export interface TokenAmount {
  token: string;
  amount: bigint;
}
/** Contract-authoritative boundary implemented by EvmHedgeAdapter. */
export interface HedgeAdapter {
  verifyDeployment(manifest: DeploymentManifest): Promise<void>;
  /** Immutable lending asset, read from the verified deployment. Required for amount-only requests. */
  loanToken?(): Promise<TokenMetadata>;
  offers(request: LoanRequest): Promise<Offer[]>;
  accept(request: LoanRequest, options: AcceptOptions): Promise<FundingResult>;
  summary(creditId: string): Promise<CreditSummary>;
  funding(creditId: string): Promise<FundingResult | null>;
  resume(creditId: string, options?: OperationOptions): Promise<CreditSummary>;
  cancel(creditId: string, options?: OperationOptions): Promise<ConfirmedTransaction>;
  repay(
    creditId: string,
    args: { amount: bigint | "max"; from: "wallet" },
    options?: OperationOptions,
  ): Promise<ConfirmedTransaction>;
  repayWithCollateral?(
    creditId: string,
    agreementHash: string,
    options?: OperationOptions,
  ): Promise<CreditSummary>;
  activity(creditId: string): Promise<Activity[]>;
  subscribe(creditId: string, callback: (summary: CreditSummary) => void): () => void;
  collateralStatus(creditId: string): Promise<CollateralStatus>;
  claimCollateral(creditId: string, options?: OperationOptions): Promise<ConfirmedTransaction>;
  operatorSummary(operator: string): Promise<OperatorSummary>;
  deposit(operator: string, args: TokenAmount): Promise<ConfirmedTransaction>;
  withdraw(operator: string, args: TokenAmount): Promise<ConfirmedTransaction>;
  operatorOffers(operator: string): Promise<Offer[]>;
  offer(id: string): Promise<Offer>;
  publishOffer(operator: string, terms: Offer): Promise<ConfirmedTransaction>;
  withdrawOffer(operator: string, id: string): Promise<ConfirmedTransaction>;
  authorizeDefault(operator: string, creditId: string): Promise<ConfirmedTransaction>;
  claimRecovery(operator: string, creditId: string): Promise<ConfirmedTransaction>;
}
