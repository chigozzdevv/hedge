import { databaseConnected } from "../../shared/database/database.client.js";
import type { HedgeChainClient } from "../../shared/chain/hedge.client.js";
import { HedgeHttpError } from "../../shared/http/http.errors.js";
import { queue } from "../../shared/queue/queue.client.js";
import { creditSummarySchema } from "./credit.schema.js";
import { creditRepo } from "./credit.repo.js";
export function createCreditService(chain: HedgeChainClient) {
  const refresh = async (id: string, options: { requireStorage?: boolean } = {}) => {
    if (options.requireStorage && !databaseConnected())
      throw new HedgeHttpError(503, "tracking-storage-unavailable");
    const reader = await chain.ready(),
      value = await reader.credit(id);
    if (!value) throw new HedgeHttpError(404, "credit-not-found");
    const observation = chain.validate(value, "hedera");
    observation.data = chain.parseData(creditSummarySchema, observation.data);
    chain.assertInstance(observation.data.instance_id);
    if (observation.data.credit_id !== id) throw new HedgeHttpError(502, "credit-id-mismatch");
    const stored = await creditRepo.save(observation);
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
        kind: "credit.tracked",
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
export type CreditService = ReturnType<typeof createCreditService>;
