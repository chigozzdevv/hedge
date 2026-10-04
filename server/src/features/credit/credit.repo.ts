import type { CreditSummary } from "@hedge/schema";
import type { ChainObservation } from "../../shared/chain/chain.schema.js";
import { saveObservation } from "../../shared/database/observations.js";
import { HedgeCreditModel, creditTable } from "./credit.model.js";
export const creditRepo = {
  save(value: ChainObservation<CreditSummary>): Promise<boolean> {
    const instanceId = value.data.instance_id,
      creditId = value.data.credit_id;
    return saveObservation(HedgeCreditModel, creditTable, value, instanceId, creditId, {
      instanceId,
      creditId,
    });
  },
};
