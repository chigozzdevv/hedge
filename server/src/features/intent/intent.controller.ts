import type { FastifyRequest } from "fastify";
import { intentSchema } from "./intent.schema.js";
import type { IntentService } from "./intent.service.js";
export function createIntentController(service: IntentService) {
  return {
    offers(request: FastifyRequest) {
      return service.offers(intentSchema.parse(request.body));
    },
  };
}
