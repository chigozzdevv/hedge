import type { LoanRequest } from "@hedge/schema";
import { HedgeError } from "../client/hedge-error";
import type { ClientContext } from "../client/client-context";
import { Credit } from "../credit/credit";
import type { AcceptOptions } from "../types/adapter.types";
import { freezeRecord } from "../client/freeze-record";
import { sameAddress } from "../evm/address";
export class Intent {
  constructor(
    private readonly context: ClientContext,
    readonly request: LoanRequest,
  ) {}
  async offers() {
    await this.context.ready();
    return (await this.context.adapter.offers(this.request)).map((value) =>
      this.context.offer(value),
    );
  }
  async accept(options: AcceptOptions): Promise<Credit> {
    const reviewed = freezeRecord(this.context.offer(options.reviewedOffer));
    const offerId = options.offer_id;
    if (reviewed.id !== offerId)
      throw new HedgeError("OFFER_MISMATCH", "Review the selected offer before accepting");
    this.context.assertFunding(reviewed.funding, this.request.funding);
    if (
      (this.request.credit && this.request.credit.duration !== reviewed.duration) ||
      (this.request.collateral &&
        (!sameAddress(this.request.collateral.asset, reviewed.collateral.asset) ||
          this.request.collateral.amount !== reviewed.collateral.amount))
    )
      throw new HedgeError("OFFER_MISMATCH", "Offer does not match the requested term or pledge");
    const acceptedOptions = { ...options, offer_id: offerId, reviewedOffer: reviewed };
    await this.context.ready();
    const result = this.context.funding(
      await this.context.adapter.accept(this.request, acceptedOptions),
    );
    if (result.offer_id !== offerId)
      throw new HedgeError("OFFER_MISMATCH", "Funding belongs to another offer");
    this.context.assertFunding(result.funding, this.request.funding);
    return new Credit(this.context, result.credit_id);
  }
}
