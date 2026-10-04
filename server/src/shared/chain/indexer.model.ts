import mongoose from "mongoose";
import { registerMigration } from "../database/postgres.js";
registerMigration(
  "hedge_index",
  `CREATE TABLE hedge_index_cursors (
  id text PRIMARY KEY, next_block numeric(78,0) NOT NULL CHECK(next_block>=0),
  last_block_hash text, indexed_at timestamptz,lease text,lease_expires_at timestamptz,
  integrity_failure text,created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE hedge_chain_events(id text PRIMARY KEY,event jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE INDEX hedge_chain_events_lookup ON hedge_chain_events((event->>'chainId'),(event->>'contract'),(event->>'creditId'),(event->>'block'))`,
);

const cursorSchema = new mongoose.Schema(
  {
    _id: String,
    nextBlock: { type: String, required: true },
    lastBlockHash: String,
    indexedAt: Date,
    lease: String,
    leaseExpiresAt: Date,
    integrityFailure: String,
  },
  { timestamps: true },
);
const eventSchema = new mongoose.Schema(
  {
    _id: String,
    chainId: { type: Number, required: true },
    contract: { type: String, required: true },
    block: { type: String, required: true },
    blockHash: { type: String, required: true },
    txHash: { type: String, required: true },
    logIndex: { type: Number, required: true },
    event: { type: String, required: true },
    creditId: String,
    data: mongoose.Schema.Types.Mixed,
  },
  { timestamps: true },
);
eventSchema.index({ chainId: 1, contract: 1, creditId: 1, block: 1 });
export const HedgeIndexCursorModel =
  mongoose.models["HedgeIndexCursor"] ?? mongoose.model("HedgeIndexCursor", cursorSchema);
export const HedgeEventModel =
  mongoose.models["HedgeChainEvent"] ?? mongoose.model("HedgeChainEvent", eventSchema);
