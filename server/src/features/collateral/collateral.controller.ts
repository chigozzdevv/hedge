import type { FastifyRequest } from "fastify";
import { collateralParamsSchema, collateralTrackSchema } from "./collateral.schema.js";
import type { CollateralService } from "./collateral.service.js";
export function createCollateralController(service: CollateralService) {
  return {
    get(request: FastifyRequest) {
      return service.get(collateralParamsSchema.parse(request.params).id);
    },
    track(request: FastifyRequest) {
      return service.track(collateralTrackSchema.parse(request.body).creditId);
    },
  };
}
