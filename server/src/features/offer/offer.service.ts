import type { LoanRequest, Offer } from "@hedge/schema";
import type { ChainObservation } from "../../shared/chain/chain.schema.js";
import { HedgeChainClient } from "../../shared/chain/hedge.client.js";
import { HedgeHttpError } from "../../shared/http/http.errors.js";
import { offerSchema } from "./offer.schema.js";
import { offerRepo } from "./offer.repo.js";

export function createOfferService(chain: HedgeChainClient) {
  const validated = (raw: ChainObservation<Offer> | null) => {
    if (!raw) throw new HedgeHttpError(404, "offer-not-found");
    const observation = chain.validate(raw, "hedera");
    observation.data = chain.parseData(offerSchema, observation.data);
    chain.assertInstance(observation.data.instance_id);
    return observation;
  };
  return {
    async offers(request: LoanRequest) {
      const reader = await chain.ready();
      const observations = (await reader.offers(request)).map(validated);
      await Promise.all(observations.map((value) => offerRepo.save(value)));
      return observations;
    },
    async get(id: string) {
      const reader = await chain.ready();
      const observation = validated(await reader.offer(id));
      if (observation.data.id !== id) throw new HedgeHttpError(502, "offer-id-mismatch");
      await offerRepo.save(observation);
      return observation;
    },
  };
}
export type OfferService = ReturnType<typeof createOfferService>;
