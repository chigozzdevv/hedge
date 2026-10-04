import type { ClientContext } from "../client/client-context";
import type { OperationOptions } from "../types/adapter.types";
export class Collateral {
  constructor(
    private readonly context: ClientContext,
    private readonly creditId: string,
  ) {}
  async status() {
    await this.context.ready();
    return this.context.adapter.collateralStatus(this.creditId);
  }
  async claim(options?: OperationOptions) {
    await this.context.ready();
    return this.context.transaction(
      await this.context.adapter.claimCollateral(this.creditId, options),
      "base",
    );
  }
}
