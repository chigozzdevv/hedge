import type { FundingRequest, FundingResult } from "@hedge/schema";
import type { HedgeClient } from "../client/hedge-client";
/** Presentation only. The app still owns its quote, approval and transaction. */
export interface ModalContext {
  title: string;
  description?: string;
  continueLabel: string;
}
export type ModalRequest = (
  | { amount: string; funding?: never; credit_id?: never }
  | { funding: FundingRequest; credit_id?: never; amount?: never }
  | { credit_id: string; funding?: never; amount?: never }
) & { context?: ModalContext };
export type OpenOptions = ModalRequest & {
  onFunded?: (result: FundingResult) => void | Promise<void>;
};
/** A modal returns the selected loan ID. The SDK rereads its funding before calling onFunded. */
export type ModalRenderer = (
  client: HedgeClient,
  options: ModalRequest,
) => Promise<{ credit_id: string } | null>;
