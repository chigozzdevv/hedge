import mongoose from "mongoose";
import { registerMigration } from "../database/postgres.js";
registerMigration(
  "hedge_jobs",
  `CREATE TABLE hedge_jobs (
  job_id text PRIMARY KEY, kind text NOT NULL, payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','done')),
  attempts integer NOT NULL DEFAULT 0, next_run_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lease text, lease_expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE INDEX hedge_jobs_pending ON hedge_jobs(kind,status,next_run_at,lease_expires_at)`,
);
const outboxSchema = new mongoose.Schema(
  {
    jobId: { type: String, unique: true, required: true },
    kind: { type: String, required: true },
    payload: { type: mongoose.Schema.Types.Mixed, required: true },
    status: { type: String, enum: ["pending", "processing", "done"], default: "pending" },
    attempts: { type: Number, default: 0 },
    nextRunAt: { type: Date, default: Date.now },
    lease: String,
    leaseExpiresAt: Date,
  },
  { timestamps: true },
);
outboxSchema.index({ kind: 1, status: 1, nextRunAt: 1, leaseExpiresAt: 1 });
export const HedgeJobModel =
  mongoose.models["HedgeJob"] ?? mongoose.model("HedgeJob", outboxSchema);
