import {
  deploymentSchema,
  fundingRequestSchema,
  idSchema,
  loanRequestSchema,
  addressSchema,
  decimalAmountSchema,
  parseAmount,
  tokenMetadataSchema,
  walletIdentitySchema,
  type FundingRequest,
  type WalletIdentity,
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
    let resolvedFunding: FundingRequest | undefined;
    const suppliedAmount = options.amount;
    const resolveAmount = async (wallet: WalletIdentity) => {
      const identity = freezeRecord(walletIdentitySchema.parse(wallet));
      if (identity.chain_id !== this.manifest.hedera.chain_id || !identity.account_id)
        throw new HedgeError("WALLET_MISMATCH", "Connect the configured Hedera wallet");
      if (typeof suppliedAmount !== "function" || !token)
        throw new HedgeError("INVALID_REQUEST", "The app must supply the loan amount");
      resolvedFunding = undefined;
      const value = decimalAmountSchema.parse(await suppliedAmount(identity));
      if (/^0+(?:\.0*)?$/.test(value)) return "0";
      resolvedFunding = freezeRecord(
        fundingRequestSchema.parse({
          token: token.address,
          amount: parseAmount(value, token.decimals),
          recipient: { address: identity.address, account_id: identity.account_id },
        }),
      );
      return value;
    };
    const request: ModalRequest = freezeRecord(
      options.credit_id !== undefined
        ? { credit_id: idSchema.parse(options.credit_id), ...presentation }
        : options.amount !== undefined
          ? {
              amount:
                typeof suppliedAmount === "function"
                  ? resolveAmount
                  : decimalAmountSchema.parse(suppliedAmount),
              ...presentation,
            }
          : { funding: fundingRequestSchema.parse(options.funding), ...presentation },
    );
    const onFunded = options.onFunded;
    if (!this.config.modal)
      throw new HedgeError("MODAL_UNAVAILABLE", "Configure a Use Hedge modal renderer");
    await this.ready();
    if (request.amount !== undefined && !this.config.adapter.loanToken)
      throw new HedgeError("TOKEN_UNAVAILABLE", "The adapter must read the lending asset");
    // Verify the asset now; deferred amounts are validated after wallet connection.
    const token =
      request.amount !== undefined
        ? tokenMetadataSchema.parse(await this.config.adapter.loanToken?.())
        : undefined;
    if (token && token.chain_id !== this.manifest.hedera.chain_id)
      throw new HedgeError("TOKEN_MISMATCH", "Loan token belongs to another network");
    const amount =
      token && typeof request.amount === "string"
        ? parseAmount(request.amount, token.decimals)
        : undefined;
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
    if (typeof request.amount === "function") {
      if (!resolvedFunding)
        throw new HedgeError("INVALID_REQUEST", "Confirm the app's loan amount before continuing");
      this.context.assertFunding(result.funding, resolvedFunding);
    }
    if (
      token &&
      typeof request.amount === "string" &&
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
