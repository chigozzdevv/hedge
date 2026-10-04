import type { ChainObservation } from "../../shared/chain/chain.schema.js";
import type { CollateralSummary } from "./collateral.schema.js";
import { saveObservation } from "../../shared/database/observations.js";
import { HedgeCollateralModel, collateralTable } from "./collateral.model.js";
export const collateralRepo = {
  save(value: ChainObservation<CollateralSummary>): Promise<boolean> {
    const instanceId = value.data.instance_id,
      creditId = value.data.credit_id;
    return saveObservation(HedgeCollateralModel, collateralTable, value, instanceId, creditId, {
      instanceId,
      creditId,
      lockId: value.data.lock_id,
    });
  },
};
