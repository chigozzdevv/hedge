import { createHash } from "node:crypto";
import pg, { type PoolClient, type QueryResultRow } from "pg";
import { hedgeLogger } from "../logging/hedge-logger.js";

let pool: pg.Pool | undefined;
let connecting: Promise<void> | undefined;
const migrations = new Map<string, string>();
export function registerMigration(name: string, sql: string): void {
  if (!/^hedge_[a-z_]+$/.test(name)) throw new Error("database-table-invalid");
  const existing = migrations.get(name);
  if (existing && existing !== sql) throw new Error("database-migration-conflict");
  migrations.set(name, sql);
}
export function postgresConnected(): boolean {
  return pool !== undefined;
}
export async function sqlQuery<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  values: unknown[] = [],
) {
  if (!pool) throw new Error("database-unconfigured");
  return pool.query<T>(sql, values);
}
export async function sqlTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  if (!pool) throw new Error("database-unconfigured");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
export async function connectPostgres(url: string): Promise<void> {
  if (pool) return;
  if (connecting) return connecting;
  connecting = initializePostgres(url);
  try {
    await connecting;
  } finally {
    connecting = undefined;
  }
}
async function initializePostgres(url: string): Promise<void> {
  const candidate = new pg.Pool({
    connectionString: url,
    max: 10,
    connectionTimeoutMillis: 5000,
    query_timeout: 15000,
    application_name: "hedge",
  });
  candidate.on("error", () => hedgeLogger.error("postgres-connection-unavailable"));
  try {
    const client = await candidate.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(724314101)");
      await client.query(`CREATE TABLE IF NOT EXISTS hedge_migrations (
        id text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
      for (const [id, migration] of [...migrations].sort(([a], [b]) => a.localeCompare(b))) {
        const checksum = createHash("sha256").update(migration).digest("hex");
        const existing = await client.query<{ checksum: string }>(
          "SELECT checksum FROM hedge_migrations WHERE id=$1",
          [id],
        );
        if (existing.rows[0]) {
          if (existing.rows[0].checksum !== checksum)
            throw new Error("database-migration-checksum-changed");
          continue;
        }
        await client.query(migration);
        await client.query("INSERT INTO hedge_migrations(id,checksum) VALUES($1,$2)", [
          id,
          checksum,
        ]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    pool = candidate;
  } catch (error) {
    await candidate.end();
    throw error;
  }
}
export async function closePostgres(): Promise<void> {
  await connecting;
  const previous = pool;
  pool = undefined;
  await previous?.end();
}
