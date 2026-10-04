import mongoose from "mongoose";
import { registerMigration } from "../../shared/database/postgres.js";

registerMigration(
  "hedge_liquidity",
  `
  CREATE TABLE hedge_liquidity_state (
    scope text PRIMARY KEY, journal jsonb,
    lease text, lease_expires_at timestamptz
  );
  CREATE TABLE hedge_liquidity_receipts (
    id text PRIMARY KEY, scope text NOT NULL, journal jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX hedge_liquidity_receipts_scope ON hedge_liquidity_receipts(scope);
`,
);
const writeConcern = { w: "majority" as const, j: true, wtimeout: 5000 };
const stateSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    journal: { type: mongoose.Schema.Types.Mixed, default: null },
    lease: String,
    leaseExpiresAt: Date,
  },
  { writeConcern },
);
const receiptSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    scope: { type: String, required: true, index: true },
    journal: { type: mongoose.Schema.Types.Mixed, required: true },
  },
  { timestamps: true, writeConcern },
);
export const LiquidityStateModel =
  mongoose.models["HedgeLiquidityState"] ?? mongoose.model("HedgeLiquidityState", stateSchema);
export const LiquidityReceiptModel =
  mongoose.models["HedgeLiquidityReceipt"] ??
  mongoose.model("HedgeLiquidityReceipt", receiptSchema);
