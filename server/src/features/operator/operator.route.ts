import type { FastifyInstance } from "fastify";
import { createOperatorController } from "./operator.controller.js";
import type { OperatorService } from "./operator.service.js";
export function operatorRoute(app: FastifyInstance, service: OperatorService): void {
  app.get("/operator/:address", createOperatorController(service).summary);
}
