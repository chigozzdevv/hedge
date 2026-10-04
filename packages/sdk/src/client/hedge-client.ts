import {
  deploymentSchema,
  fundingRequestSchema,
  idSchema,
  loanRequestSchema,
  addressSchema,
  decimalAmountSchema,
  parseAmount,
  tokenMetadataSchema,
  type DeploymentManifest,
  type LoanRequest,
} from "@hedge/schema";
import type { HedgeAdapter } from "../types/adapter.types";
import type { ModalRenderer, ModalRequest, OpenOptions } from "../modal/modal.types";
import { ClientContext } from "./client-context";
import { HedgeError, PendingError } from "./hedge-error";
import { Intent } from "../intent/intent";
import { Credit } from "../credit/credit";
import { Operator } from "../operator/operator";
import { freezeRecord } from "./freeze-record";
import { sameAddress } from "../evm/address";
export interface HedgeConfig {
  manifest: DeploymentManifest;
  adapter: HedgeAdapter;
  modal?: ModalRenderer;
}
export class HedgeClient {
  private readonly context: ClientContext;
  constructor(private readonly config: HedgeConfig) {
    // Parse into a detached public manifest before any external adapter operation.
    if (!config.adapter)
      throw new HedgeError("ADAPTER_UNAVAILABLE", "A real chain adapter is required");
    this.context = new ClientContext(
      freezeRecord(deploymentSchema.parse(config.manifest)),
      config.adapter,
    );
  }
  ready() {
    return this.context.ready();
  }
  get manifest(): Readonly<DeploymentManifest> {
    return this.context.manifest;
  }
  intent(request: LoanRequest) {
    const parsed = freezeRecord(loanRequestSchema.parse(request));
    if (parsed.collateral && parsed.collateral.chain_id !== this.context.manifest.base.chain_id)
      throw new HedgeError("CHAIN_MISMATCH", "Collateral must use this deployment's Base chain");
    return new Intent(this.context, parsed);
  }
  credit(id: string) {
    return new Credit(this.context, idSchema.parse(id));
  }
  operator(address: string) {
    const operator = addressSchema.parse(address);
    if (/^0x0{40}$/i.test(operator))
      throw new HedgeError("OPERATOR_MISMATCH", "Select a nonzero operator wallet");
    return new Operator(this.context, operator);
  }
  async open(options: OpenOptions) {
    if (
      [options.credit_id, options.funding, options.amount].filter((value) => value !== undefined)
        .length !== 1
    )
      throw new HedgeError("INVALID_REQUEST", "Select a loan or request funding");
    const context = options.context;
    if (
      context &&
      (typeof context.title !== "string" ||
        !context.title.trim() ||
        context.title.length > 120 ||
        typeof context.continueLabel !== "string" ||
        !context.continueLabel.trim() ||
        context.continueLabel.length > 80 ||
        (context.description !== undefined &&
          (typeof context.description !== "string" || context.description.length > 240)))
    )
      throw new HedgeError("INVALID_REQUEST", "Provide a short title and continuation label");
    const presentation = context
      ? {
          context: {
            title: context.title,
            continueLabel: context.continueLabel,
            ...(context.description !== undefined ? { description: context.description } : {}),
          },
        }
      : {};
    const request: ModalRequest = freezeRecord(
      options.credit_id !== undefined
        ? { credit_id: idSchema.parse(options.credit_id), ...presentation }
        : options.amount !== undefined
          ? { amount: decimalAmountSchema.parse(options.amount), ...presentation }
          : { funding: fundingRequestSchema.parse(options.funding), ...presentation },
    );
    const onFunded = options.onFunded;
    if (!this.config.modal)
      throw new HedgeError("MODAL_UNAVAILABLE", "Configure a Use Hedge modal renderer");
    await this.ready();
    if (request.amount !== undefined && !this.config.adapter.loanToken)
      throw new HedgeError("TOKEN_UNAVAILABLE", "The adapter must read the lending asset");
    // Validate precision and asset before opening the UI. Recipient is resolved in the connected modal.
    const token =
      request.amount !== undefined
        ? tokenMetadataSchema.parse(await this.config.adapter.loanToken?.())
        : undefined;
    if (token && token.chain_id !== this.manifest.hedera.chain_id)
      throw new HedgeError("TOKEN_MISMATCH", "Loan token belongs to another network");
    const amount = token ? parseAmount(request.amount!, token.decimals) : undefined;
    const selection = await this.config.modal(this, request);
    if (selection === null) return null;
    const credit = this.credit(selection.credit_id);
    if (request.credit_id !== undefined && request.credit_id !== credit.id)
      throw new HedgeError("CREDIT_MISMATCH", "Modal selected a different loan");
    const result = await credit.funding();
    if (result === null)
      throw new PendingError("Loan payout is not confirmed", {
        instance_id: this.context.manifest.instance_id,
        credit_id: credit.id,
        stage: "funding_pending",
      });
    if (request.funding) this.context.assertFunding(result.funding, request.funding);
    if (
      token &&
      (!sameAddress(token.address, result.funding.token) || result.funding.amount !== amount)
    )
      throw new HedgeError(
        "FUNDING_MISMATCH",
        "Payout differs from the requested loan amount or token",
      );
    await onFunded?.(result);
    return result;
  }
}
export const create_hedge = (config: HedgeConfig): HedgeClient => new HedgeClient(config);
