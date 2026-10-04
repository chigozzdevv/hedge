import mongoose from "mongoose";
import { observationTable } from "../../shared/database/observations.js";
export const collateralTable = observationTable("hedge_collateral");
const collateralSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    instanceId: { type: String, required: true },
    creditId: { type: String, required: true },
    lockId: String,
    observedBlock: { type: Number, required: true },
    observedHash: { type: String, required: true },
    snapshot: { type: mongoose.Schema.Types.Mixed, required: true },
  },
  { timestamps: true },
);
collateralSchema.index({ instanceId: 1, creditId: 1 }, { unique: true });
export const HedgeCollateralModel =
  mongoose.models["HedgeCollateral"] ?? mongoose.model("HedgeCollateral", collateralSchema);
