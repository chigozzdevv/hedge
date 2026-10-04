import type { Offer } from "@hedge/schema";
import type { ChainObservation } from "../../shared/chain/chain.schema.js";
import { saveObservation } from "../../shared/database/observations.js";
import { HedgeOfferModel, offerTable } from "./offer.model.js";
export const offerRepo = {
  async save(value: ChainObservation<Offer>): Promise<void> {
    const instanceId = value.data.instance_id,
      offerId = value.data.id;
    await saveObservation(HedgeOfferModel, offerTable, value, instanceId, offerId, {
      instanceId,
      offerId,
    });
  },
};
