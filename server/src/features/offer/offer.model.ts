import mongoose from "mongoose";
import { observationTable } from "../../shared/database/observations.js";
export const offerTable = observationTable("hedge_offers");

const offerSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    instanceId: { type: String, required: true },
    offerId: { type: String, required: true },
    observedBlock: { type: Number, required: true },
    observedHash: { type: String, required: true },
    snapshot: { type: mongoose.Schema.Types.Mixed, required: true },
  },
  { timestamps: true },
);
offerSchema.index({ instanceId: 1, offerId: 1 }, { unique: true });
export const HedgeOfferModel =
  mongoose.models["HedgeOffer"] ?? mongoose.model("HedgeOffer", offerSchema);
