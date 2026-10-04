import type { FastifyInstance } from "fastify";
import { createIntentController } from "./intent.controller.js";
import type { IntentService } from "./intent.service.js";
export function intentRoute(app: FastifyInstance, service: IntentService): void {
  app.post("/intents/offers", createIntentController(service).offers);
}
