import mongoose from "mongoose";
import { observationTable } from "../../shared/database/observations.js";
export const creditTable = observationTable("hedge_credits");
const creditSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    instanceId: { type: String, required: true },
    creditId: { type: String, required: true },
    observedBlock: { type: Number, required: true },
    observedHash: { type: String, required: true },
    snapshot: { type: mongoose.Schema.Types.Mixed, required: true },
  },
  { timestamps: true },
);
creditSchema.index({ instanceId: 1, creditId: 1 }, { unique: true });
export const HedgeCreditModel =
  mongoose.models["HedgeCredit"] ?? mongoose.model("HedgeCredit", creditSchema);
