import type { Model } from "mongoose";
import type { ChainObservation } from "../chain/chain.schema.js";
import { httpJson } from "../http/http.serialization.js";
import { databaseConnected, usesPostgres } from "./database.client.js";
import { registerMigration, sqlQuery } from "./postgres.js";

export function observationTable(name: string): string {
  registerMigration(
    name,
    `CREATE TABLE ${name} (
    id text PRIMARY KEY, instance_id text NOT NULL, resource_id text NOT NULL,
    observed_block bigint NOT NULL CHECK (observed_block >= 0), observed_hash text NOT NULL,
    snapshot jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(instance_id,resource_id))`,
  );
  return name;
}
/** Both drivers retain instance isolation and reject conflicting hashes at the same block. */
export async function saveObservation<T>(
  model: Model<T>,
  table: string,
  value: ChainObservation<unknown>,
  instanceId: string,
  resourceId: string,
  fields: Record<string, string | null | undefined>,
): Promise<boolean> {
  if (!databaseConnected()) return false;
  const id = JSON.stringify([instanceId, resourceId]);
  const snapshot = httpJson(value.data);
  if (usesPostgres()) {
    if (!/^hedge_[a-z_]+$/.test(table)) throw new Error("database-table-invalid");
    const result = await sqlQuery(
      `INSERT INTO ${table}
      (id,instance_id,resource_id,observed_block,observed_hash,snapshot) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(id) DO UPDATE SET observed_block=EXCLUDED.observed_block,
        observed_hash=EXCLUDED.observed_hash,snapshot=EXCLUDED.snapshot,updated_at=CURRENT_TIMESTAMP
      WHERE ${table}.observed_block < EXCLUDED.observed_block OR
        (${table}.observed_block=EXCLUDED.observed_block AND ${table}.observed_hash=EXCLUDED.observed_hash)
      RETURNING id`,
      [
        id,
        instanceId,
        resourceId,
        value.observedBlock,
        value.observedHash,
        JSON.stringify(snapshot),
      ],
    );
    if (!result.rowCount) {
      const current = (
        await sqlQuery<{ observed_block: string; observed_hash: string }>(
          `SELECT observed_block,observed_hash FROM ${table} WHERE id=$1`,
          [id],
        )
      ).rows[0];
      if (
        !current ||
        BigInt(current.observed_block) < BigInt(value.observedBlock) ||
        (BigInt(current.observed_block) === BigInt(value.observedBlock) &&
          current.observed_hash !== value.observedHash)
      )
        throw new Error("observation-block-conflict");
    }
    return true;
  }
  try {
    await model.findOneAndUpdate(
      {
        _id: id,
        $or: [
          { observedBlock: { $lt: value.observedBlock } },
          { observedBlock: value.observedBlock, observedHash: value.observedHash },
        ],
      },
      {
        $set: {
          ...fields,
          observedBlock: value.observedBlock,
          observedHash: value.observedHash,
          snapshot,
        },
      },
      { upsert: true },
    );
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== 11000)
      throw error;
    const current = (await model.findById(id).lean()) as {
      observedBlock: number;
      observedHash: string;
    } | null;
    if (
      !current ||
      current.observedBlock < value.observedBlock ||
      (current.observedBlock === value.observedBlock && current.observedHash !== value.observedHash)
    )
      throw error;
  }
  return true;
}
