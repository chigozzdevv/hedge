import type { FastifyInstance } from "fastify";
import { createOfferController } from "./offer.controller.js";
import type { OfferService } from "./offer.service.js";
export function offerRoute(app: FastifyInstance, service: OfferService): void {
  app.get("/offers/:id", createOfferController(service).get);
}
