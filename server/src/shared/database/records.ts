import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { databaseConnected, usesPostgres } from "./database.client.js";
import { registerMigration, sqlQuery } from "./postgres.js";

registerMigration(
  "hedge_records",
  `
  CREATE TABLE hedge_records (scope text NOT NULL, key text NOT NULL, value jsonb NOT NULL,
    PRIMARY KEY(scope,key));
  CREATE TABLE hedge_record_leases (scope text PRIMARY KEY, lease text NOT NULL,
    expires_at timestamptz NOT NULL);
`,
);
const options = { writeConcern: { w: "majority" as const, j: true, wtimeout: 5000 } };
const RecordModel =
  mongoose.models["HedgeRecord"] ??
  mongoose.model(
    "HedgeRecord",
    new mongoose.Schema(
      { _id: String, scope: String, key: String, value: mongoose.Schema.Types.Mixed },
      options,
    ),
  );
const LeaseModel =
  mongoose.models["HedgeRecordLease"] ??
  mongoose.model(
    "HedgeRecordLease",
    new mongoose.Schema({ _id: String, lease: String, expiresAt: Date }, options),
  );
function requireDatabase() {
  if (!databaseConnected())
    throw new Error(
      "Connect the configured MongoDB/PostgreSQL before running Hedge services or signing",
    );
}
export async function readRecord<T>(scope: string, key: string): Promise<T | undefined> {
  requireDatabase();
  if (usesPostgres())
    return (
      await sqlQuery("SELECT value FROM hedge_records WHERE scope=$1 AND key=$2", [scope, key])
    ).rows[0]?.["value"] as T | undefined;
  return (await RecordModel.findById(JSON.stringify([scope, key])).lean())?.["value"] as
    | T
    | undefined;
}
export async function recordKeys(scope: string): Promise<string[]> {
  requireDatabase();
  if (usesPostgres())
    return (
      await sqlQuery<{ key: string }>("SELECT key FROM hedge_records WHERE scope=$1", [scope])
    ).rows.map((row) => row.key);
  return (await RecordModel.find({ scope }).select({ key: 1 }).lean()).map((row) =>
    String(row["key"]),
  );
}
export async function writeRecord(scope: string, key: string, value: unknown): Promise<void> {
  requireDatabase();
  if (usesPostgres())
    await sqlQuery(
      "INSERT INTO hedge_records(scope,key,value) VALUES($1,$2,$3::jsonb) ON CONFLICT(scope,key) DO UPDATE SET value=EXCLUDED.value",
      [scope, key, JSON.stringify(value)],
    );
  else
    await RecordModel.updateOne(
      { _id: JSON.stringify([scope, key]) },
      { $set: { scope, key, value } },
      { upsert: true },
    );
}
export async function createRecord<T>(scope: string, key: string, value: T): Promise<T> {
  requireDatabase();
  if (usesPostgres())
    await sqlQuery(
      "INSERT INTO hedge_records(scope,key,value) VALUES($1,$2,$3::jsonb) ON CONFLICT(scope,key) DO NOTHING",
      [scope, key, JSON.stringify(value)],
    );
  else {
    try {
      await RecordModel.updateOne(
        { _id: JSON.stringify([scope, key]) },
        { $setOnInsert: { scope, key, value } },
        { upsert: true },
      );
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
    }
  }
  const saved = await readRecord<T>(scope, key);
  if (saved === undefined) throw new Error("Signed transaction recovery was not persisted");
  return saved;
}
export async function withRecordLease<T>(
  scope: string,
  action: (assertOwned: () => Promise<void>) => Promise<T>,
): Promise<T> {
  requireDatabase();
  const lease = randomUUID();
  let acquired: boolean;
  if (usesPostgres())
    acquired =
      (
        await sqlQuery(
          `INSERT INTO hedge_record_leases(scope,lease,expires_at) VALUES($1,$2,clock_timestamp()+interval '120 seconds')
    ON CONFLICT(scope) DO UPDATE SET lease=$2,expires_at=clock_timestamp()+interval '120 seconds'
    WHERE hedge_record_leases.expires_at<=clock_timestamp() RETURNING scope`,
          [scope, lease],
        )
      ).rowCount === 1;
  else {
    try {
      await LeaseModel.updateOne(
        { _id: scope },
        { $setOnInsert: { lease: "", expiresAt: new Date(0) } },
        { upsert: true },
      );
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
    }
    {
      acquired = !!(await LeaseModel.findOneAndUpdate(
        { _id: scope, $expr: { $lte: ["$expiresAt", "$$NOW"] } },
        [{ $set: { lease, expiresAt: { $add: ["$$NOW", 120_000] } } }],
        { returnDocument: "after", updatePipeline: true },
      ));
    }
  }
  if (!acquired) throw new Error("Another command is using this wallet; retry after it completes");
  let lost = false;
  const assertOwned = async () => {
    if (lost) throw new Error("Database signing lease lost; resume the saved operation");
    const count = usesPostgres()
      ? (
          await sqlQuery(
            "UPDATE hedge_record_leases SET expires_at=clock_timestamp()+interval '120 seconds' WHERE scope=$1 AND lease=$2 AND expires_at>clock_timestamp()",
            [scope, lease],
          )
        ).rowCount
      : (
          await LeaseModel.updateOne(
            { _id: scope, lease, $expr: { $gt: ["$expiresAt", "$$NOW"] } },
            [{ $set: { expiresAt: { $add: ["$$NOW", 120_000] } } }],
            { updatePipeline: true },
          )
        ).matchedCount;
    if (count !== 1) {
      lost = true;
      throw new Error("Database signing lease lost; resume the saved operation");
    }
  };
  let renewing: Promise<void> = Promise.resolve();
  const timer = setInterval(() => {
    renewing = assertOwned().catch(() => {
      lost = true;
    });
  }, 30_000);
  timer.unref();
  try {
    return await action(assertOwned);
  } finally {
    clearInterval(timer);
    await renewing;
    if (usesPostgres())
      await sqlQuery("DELETE FROM hedge_record_leases WHERE scope=$1 AND lease=$2", [scope, lease]);
    else await LeaseModel.deleteOne({ _id: scope, lease });
  }
}
