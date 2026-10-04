import type { FastifyRequest } from "fastify";
import { creditParamsSchema, creditTrackSchema } from "./credit.schema.js";
import type { CreditService } from "./credit.service.js";
export function createCreditController(service: CreditService) {
  return {
    get(request: FastifyRequest) {
      return service.get(creditParamsSchema.parse(request.params).id);
    },
    track(request: FastifyRequest) {
      return service.track(creditTrackSchema.parse(request.body).creditId);
    },
  };
}
