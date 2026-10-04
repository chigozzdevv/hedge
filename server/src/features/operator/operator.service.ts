import type { HedgeChainClient } from "../../shared/chain/hedge.client.js";
import { HedgeHttpError } from "../../shared/http/http.errors.js";
import { operatorSchema } from "./operator.schema.js";
import { sameAddress } from "@hedge/sdk";
export function createOperatorService(chain: HedgeChainClient) {
  return {
    async summary(address: string) {
      const reader = await chain.ready();
      const observation = chain.validate(await reader.operator(address), "hedera");
      observation.data = chain.parseData(operatorSchema, observation.data);
      chain.assertInstance(observation.data.instance_id);
      if (!sameAddress(observation.data.operator, address))
        throw new HedgeHttpError(502, "operator-mismatch");
      return observation;
    },
  };
}
export type OperatorService = ReturnType<typeof createOperatorService>;
