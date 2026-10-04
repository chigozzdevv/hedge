import type { LoanRequest } from "@hedge/schema";
import { HedgeHttpError } from "../../shared/http/http.errors.js";
import type { HedgeChainClient } from "../../shared/chain/hedge.client.js";
import type { OfferService } from "../offer/offer.index.js";

export function createIntentService(chain: HedgeChainClient, offers: OfferService) {
  return {
    async offers(request: LoanRequest) {
      await chain.ready();
      if (request.collateral && request.collateral.chain_id !== chain.manifest?.base.chain_id)
        throw new HedgeHttpError(400, "collateral-chain-mismatch");
      const results = await offers.offers(request),
        expected = request.funding;
      return results.filter(
        ({ data: offer }) =>
          offer.funding.token.toLowerCase() === expected.token.toLowerCase() &&
          offer.funding.amount === expected.amount &&
          offer.funding.recipient.account_id === expected.recipient.account_id &&
          offer.funding.recipient.address.toLowerCase() ===
            expected.recipient.address.toLowerCase() &&
          (!request.credit || offer.duration === request.credit.duration) &&
          (!request.collateral ||
            (offer.collateral.asset.toLowerCase() === request.collateral.asset.toLowerCase() &&
              offer.collateral.amount === request.collateral.amount)),
      );
    },
  };
}
export type IntentService = ReturnType<typeof createIntentService>;
