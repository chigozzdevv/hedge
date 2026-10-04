import { randomUUID } from "node:crypto";
import { sqlQuery } from "../database/postgres.js";
import { httpJson } from "../http/http.serialization.js";
import type { IndexCursor } from "./indexer.repo.js";

export const postgresIndex = {
  async claim(key: string, start: bigint): Promise<IndexCursor | null> {
    await sqlQuery(
      "INSERT INTO hedge_index_cursors(id,next_block) VALUES($1,$2) ON CONFLICT(id) DO NOTHING",
      [key, start.toString()],
    );
    const lease = randomUUID();
    const result = await sqlQuery<{ next_block: string; last_block_hash: string | null }>(
      `UPDATE hedge_index_cursors
      SET lease=$2,lease_expires_at=CURRENT_TIMESTAMP+interval '180 seconds',updated_at=CURRENT_TIMESTAMP
      WHERE id=$1 AND integrity_failure IS NULL AND (lease_expires_at IS NULL OR lease_expires_at<=CURRENT_TIMESTAMP)
      RETURNING next_block,last_block_hash`,
      [key, lease],
    );
    const row = result.rows[0];
    return row
      ? {
          nextBlock: row.next_block,
          lease,
          ...(row.last_block_hash ? { lastBlockHash: row.last_block_hash } : {}),
        }
      : null;
  },
  async renew(key: string, lease: string): Promise<boolean> {
    const result = await sqlQuery(
      `UPDATE hedge_index_cursors SET lease_expires_at=CURRENT_TIMESTAMP+interval '180 seconds',
      updated_at=CURRENT_TIMESTAMP WHERE id=$1 AND lease=$2 AND lease_expires_at>CURRENT_TIMESTAMP
      AND integrity_failure IS NULL`,
      [key, lease],
    );
    return result.rowCount === 1;
  },
  async record(id: string, event: Record<string, unknown>): Promise<void> {
    await sqlQuery(
      "INSERT INTO hedge_chain_events(id,event) VALUES($1,$2) ON CONFLICT(id) DO NOTHING",
      [id, JSON.stringify(httpJson(event))],
    );
  },
  async advance(
    key: string,
    lease: string,
    nextBlock: bigint,
    lastBlockHash: string,
  ): Promise<void> {
    const result = await sqlQuery(
      `UPDATE hedge_index_cursors SET next_block=$3,last_block_hash=$4,indexed_at=CURRENT_TIMESTAMP,
      updated_at=CURRENT_TIMESTAMP WHERE id=$1 AND lease=$2 AND lease_expires_at>CURRENT_TIMESTAMP
      AND integrity_failure IS NULL`,
      [key, lease, nextBlock.toString(), lastBlockHash],
    );
    if (result.rowCount !== 1) throw new Error("indexer-lease-lost");
  },
  async integrityFailure(key: string, lease: string): Promise<void> {
    await sqlQuery(
      `UPDATE hedge_index_cursors SET integrity_failure='finalized-block-changed',updated_at=CURRENT_TIMESTAMP
      WHERE id=$1 AND lease=$2`,
      [key, lease],
    );
  },
  async release(key: string, lease: string): Promise<void> {
    await sqlQuery(
      `UPDATE hedge_index_cursors SET lease=NULL,lease_expires_at=NULL,updated_at=CURRENT_TIMESTAMP
      WHERE id=$1 AND lease=$2`,
      [key, lease],
    );
  },
};
