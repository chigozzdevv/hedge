import { randomUUID } from "node:crypto";
import { sqlQuery } from "../database/postgres.js";
import { httpJson } from "../http/http.serialization.js";
import { hedgeJobId } from "./job-id.js";
import type { Job } from "./queue.client.js";

export const postgresQueue = {
  async push(job: Job): Promise<void> {
    await sqlQuery(
      `INSERT INTO hedge_jobs(job_id,kind,payload) VALUES($1,$2,$3)
      ON CONFLICT(job_id) DO NOTHING`,
      [hedgeJobId(job), job.kind, JSON.stringify(httpJson(job.payload))],
    );
  },
  async claim(kinds: readonly string[]) {
    const lease = randomUUID();
    const result = await sqlQuery<{
      job_id: string;
      kind: string;
      payload: Record<string, unknown>;
      attempts: number;
    }>(
      `
      WITH candidate AS (SELECT job_id FROM hedge_jobs WHERE kind=ANY($1::text[]) AND (
        (status='pending' AND next_run_at<=CURRENT_TIMESTAMP) OR
        (status='processing' AND lease_expires_at<=CURRENT_TIMESTAMP) OR
        (status='processing' AND lease_expires_at IS NULL AND updated_at<=CURRENT_TIMESTAMP-interval '60 seconds'))
        ORDER BY created_at,job_id FOR UPDATE SKIP LOCKED LIMIT 1)
      UPDATE hedge_jobs AS jobs SET status='processing',lease=$2,
        lease_expires_at=CURRENT_TIMESTAMP+interval '60 seconds',attempts=attempts+1,updated_at=CURRENT_TIMESTAMP
      FROM candidate WHERE jobs.job_id=candidate.job_id
      RETURNING jobs.job_id,jobs.kind,jobs.payload,jobs.attempts`,
      [kinds, lease],
    );
    const row = result.rows[0];
    return row
      ? {
          id: row.job_id,
          lease,
          attempts: row.attempts,
          job: { kind: row.kind, payload: row.payload },
        }
      : undefined;
  },
  async renew(id: string, lease: string): Promise<boolean> {
    const result = await sqlQuery(
      `UPDATE hedge_jobs SET lease_expires_at=CURRENT_TIMESTAMP+interval '60 seconds',
      updated_at=CURRENT_TIMESTAMP WHERE job_id=$1 AND lease=$2 AND status='processing'
      AND lease_expires_at>CURRENT_TIMESTAMP`,
      [id, lease],
    );
    return result.rowCount === 1;
  },
  async complete(id: string, lease: string): Promise<boolean> {
    const result = await sqlQuery(
      `DELETE FROM hedge_jobs WHERE job_id=$1 AND lease=$2
      AND status='processing' AND lease_expires_at>CURRENT_TIMESTAMP`,
      [id, lease],
    );
    return result.rowCount === 1;
  },
  async retry(id: string, lease: string, attempts: number): Promise<void> {
    const delay = Math.min(300_000, 2000 * 2 ** Math.min(8, Math.max(0, attempts - 1)));
    await sqlQuery(
      `UPDATE hedge_jobs SET status='pending',next_run_at=CURRENT_TIMESTAMP+$3*interval '1 millisecond',
      lease=NULL,lease_expires_at=NULL,updated_at=CURRENT_TIMESTAMP
      WHERE job_id=$1 AND lease=$2 AND status='processing' AND lease_expires_at>CURRENT_TIMESTAMP`,
      [id, lease, delay],
    );
  },
};
