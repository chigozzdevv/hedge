import type { FastifyInstance } from "fastify";
import { createCollateralController } from "./collateral.controller.js";
import type { CollateralService } from "./collateral.service.js";
export function collateralRoute(app: FastifyInstance, service: CollateralService): void {
  const controller = createCollateralController(service);
  app.get("/credits/:id/collateral", controller.get);
  app.post("/collateral", controller.track);
}
