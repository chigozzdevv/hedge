import type {
  Checkpoint,
  CreditSummary,
  FundingResult,
  ModalRequest,
  Offer,
  Chain,
  WalletIdentity,
  TokenMetadata,
  ConfirmedTransaction,
} from "@hedge/sdk";
export interface AcceptedTerms {
  instance_id: string;
  credit_id: string;
  agreement_hash: string;
  offer: Offer;
}
/** Implement these reads/connectors with the same verified deployment and wallets as the SDK adapter. */
export interface ModalServices {
  connect(chain: Chain): Promise<WalletIdentity>;
  wallet(chain: Chain): Promise<WalletIdentity | null>;
  token(chain: Chain, address: string): Promise<TokenMetadata>;
  agreement(creditId: string): Promise<AcceptedTerms>;
  loanToken?(): Promise<TokenMetadata>;
  outstandingLoans?(borrower: string): Promise<readonly string[]>;
  onCheckpoint?: (checkpoint: Checkpoint) => void;
  onComplete?: (creditId: string) => void;
}
export type Screen =
  | "connect"
  | "review"
  | "setup"
  | "funded"
  | "manage"
  | "repay"
  | "settle"
  | "return"
  | "complete"
  | "cancelled"
  | "defaulted";
export type LoanTransactions = Partial<
  Record<
    "accept" | "collateral" | "repaymentRequest" | "settlement" | "repayment",
    ConfirmedTransaction
  >
>;
export interface ModalSnapshot {
  open: boolean;
  screen: Screen;
  busy: boolean;
  repaymentSource?: "wallet" | "collateral";
  request?: ModalRequest;
  base?: WalletIdentity;
  hedera?: WalletIdentity;
  offers: readonly Offer[];
  offer?: Offer;
  loanToken?: TokenMetadata;
  collateralToken?: TokenMetadata;
  creditId?: string;
  summary?: CreditSummary;
  funding?: FundingResult;
  checkpoint?: Checkpoint;
  transactions?: LoanTransactions;
  error?: string;
}
