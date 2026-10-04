import type { FastifyRequest } from "fastify";
import { addressSchema } from "@hedge/schema";
import { HedgeHttpError } from "../../shared/http/http.errors.js";
import type { OperatorService } from "./operator.service.js";
export function createOperatorController(service: OperatorService) {
  return {
    summary(request: FastifyRequest<{ Params: { address: string } }>) {
      const address = addressSchema.safeParse(request.params.address);
      if (!address.success || /^0x0{40}$/i.test(address.data))
        throw new HedgeHttpError(400, "operator-address-invalid");
      return service.summary(address.data);
    },
  };
}
