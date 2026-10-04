import type { FastifyInstance } from "fastify";
import { createCreditController } from "./credit.controller.js";
import type { CreditService } from "./credit.service.js";
export function creditRoute(app: FastifyInstance, service: CreditService): void {
  const controller = createCreditController(service);
  app.get("/credits/:id", controller.get);
  app.post("/credits", controller.track);
}
