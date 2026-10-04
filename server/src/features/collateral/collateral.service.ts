import { databaseConnected } from "../../shared/database/database.client.js";
import type { HedgeChainClient } from "../../shared/chain/hedge.client.js";
import { HedgeHttpError } from "../../shared/http/http.errors.js";
import { queue } from "../../shared/queue/queue.client.js";
import { collateralSchema } from "./collateral.schema.js";
import { collateralRepo } from "./collateral.repo.js";
export function createCollateralService(chain: HedgeChainClient) {
  const refresh = async (id: string, options: { requireStorage?: boolean } = {}) => {
    if (options.requireStorage && !databaseConnected())
      throw new HedgeHttpError(503, "tracking-storage-unavailable");
    const reader = await chain.ready(),
      value = await reader.collateral(id);
    if (!value) throw new HedgeHttpError(404, "collateral-not-found");
    const observation = chain.validate(value, "base");
    observation.data = chain.parseData(collateralSchema, observation.data);
    chain.assertInstance(observation.data.instance_id);
    if (observation.data.credit_id !== id)
      throw new HedgeHttpError(502, "collateral-credit-mismatch");
    const stored = await collateralRepo.save(observation);
    if (options.requireStorage && !stored)
      throw new HedgeHttpError(503, "tracking-storage-unavailable");
    return observation;
  };
  return {
    refresh,
    get: refresh,
    async track(id: string) {
      if (!databaseConnected()) throw new HedgeHttpError(503, "tracking-storage-unavailable");
      const observation = await refresh(id, { requireStorage: true });
      await queue.push({
        kind: "collateral.tracked",
        payload: { instanceId: observation.data.instance_id, creditId: id },
        idempotencyKey: JSON.stringify([
          observation.data.instance_id,
          id,
          observation.observedBlock,
          observation.observedHash,
        ]),
      });
      return observation;
    },
  };
}
export type CollateralService = ReturnType<typeof createCollateralService>;
