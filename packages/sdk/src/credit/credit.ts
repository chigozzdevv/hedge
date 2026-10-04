import type { CreditSummary } from "@hedge/schema";
import type { ClientContext } from "../client/client-context";
import type { OperationOptions } from "../types/adapter.types";
import { Collateral } from "../collateral/collateral";
import { HedgeError } from "../client/hedge-error";
export class Credit {
  readonly collateral: Collateral;
  constructor(
    private readonly context: ClientContext,
    readonly id: string,
  ) {
    this.collateral = new Collateral(context, id);
  }
  async summary() {
    await this.context.ready();
    return this.context.summary(await this.context.adapter.summary(this.id), this.id);
  }
  async funding() {
    await this.context.ready();
    const result = await this.context.adapter.funding(this.id);
    return result === null ? null : this.context.funding(result, this.id);
  }
  async resume(options?: OperationOptions) {
    await this.context.ready();
    return this.context.summary(await this.context.adapter.resume(this.id, options), this.id);
  }
  async cancel(options?: OperationOptions) {
    await this.context.ready();
    return this.context.transaction(await this.context.adapter.cancel(this.id, options), "hedera");
  }
  async repay(args: { amount: bigint | "max"; from: "wallet" }, options?: OperationOptions) {
    await this.context.ready();
    return this.context.transaction(
      await this.context.adapter.repay(this.id, args, options),
      "hedera",
    );
  }
  async activity() {
    await this.context.ready();
    return this.context.adapter.activity(this.id);
  }
  async repayWithCollateral(agreementHash: string, options?: OperationOptions) {
    await this.context.ready();
    if (!this.context.adapter.repayWithCollateral)
      throw new HedgeError(
        "COLLATERAL_REPAYMENT_UNAVAILABLE",
        "This deployment does not support collateral repayment",
      );
    return this.context.summary(
      await this.context.adapter.repayWithCollateral(this.id, agreementHash, options),
      this.id,
    );
  }
  async subscribe(callback: (summary: CreditSummary) => void): Promise<() => void> {
    await this.context.ready();
    return this.context.adapter.subscribe(this.id, (value) =>
      callback(this.context.summary(value, this.id)),
    );
  }
}
