import type { FastifyRequest } from "fastify";
import { offerParamsSchema } from "./offer.schema.js";
import type { OfferService } from "./offer.service.js";

export function createOfferController(service: OfferService) {
  return {
    get(request: FastifyRequest) {
      return service.get(offerParamsSchema.parse(request.params).id);
    },
  };
}
