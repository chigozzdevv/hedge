import { Redis as IORedis } from "ioredis";
import { Queue as BullQueue, type JobsOptions } from "bullmq";
import { env } from "../config/env.js";
import { hedgeLogger } from "../logging/hedge-logger.js";
import { randomUUID } from "node:crypto";
import { hedgeJobId } from "./job-id.js";
import { HedgeJobModel } from "./queue.model.js";
import { databaseConnected, usesPostgres } from "../database/database.client.js";
import { postgresQueue } from "./postgres-queue.js";
import { httpJson } from "../http/http.serialization.js";

export type Job = { kind: string; payload: Record<string, unknown>; idempotencyKey?: string };

let shared: IORedis | null = null;
const connections = new Set<IORedis>();
const queues = new Map<string, BullQueue>();
const defaults: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 2000 },
  removeOnComplete: 100,
  removeOnFail: 500,
};

export function redisConnection(): IORedis | null {
  if (!env.redisUrl) return null;
  if (!shared) {
    shared = new IORedis(env.redisUrl, {
      maxRetriesPerRequest: null,
      lazyConnect: true,
      connectTimeout: 5000,
      commandTimeout: 5000,
    });
    shared.on("error", () => hedgeLogger.warn("redis-unavailable"));
  }
  return shared;
}

export async function closeRedis(): Promise<void> {
  const queueResults = await Promise.allSettled([...queues.values()].map((value) => value.close()));
  queues.clear();
  const connectionResults = await Promise.allSettled(
    [...connections].map(async (connection) => {
      try {
        await connection.quit();
      } finally {
        connection.disconnect();
      }
    }),
  );
  connections.clear();
  for (const result of [...queueResults, ...connectionResults]) {
    if (result.status === "rejected") hedgeLogger.error("queue-close-failed", {});
  }
  if (shared) {
    try {
      await shared.quit();
    } catch {
      hedgeLogger.error("redis-close-failed", {});
    } finally {
      shared.disconnect();
    }
    shared = null;
  }
}

export function duplicateRedis(): IORedis | null {
  const connection = redisConnection()?.duplicate() ?? null;
  if (connection) connections.add(connection);
  return connection;
}

function queueFor(kind: string): BullQueue | null {
  const conn = redisConnection();
  if (!conn) return null;
  let q = queues.get(kind);
  if (!q) {
    q = new BullQueue(kind, { connection: duplicateRedis()!, prefix: env.redisPrefix });
    q.on("error", () => hedgeLogger.warn("queue-unavailable", { kind }));
    queues.set(kind, q);
  }
  return q;
}

async function fallback(job: Job): Promise<void> {
  if (!databaseConnected()) {
    throw new Error("durable-queue-unavailable");
  }
  try {
    if (usesPostgres()) {
      await postgresQueue.push(job);
      return;
    }
    await HedgeJobModel.findOneAndUpdate(
      { jobId: hedgeJobId(job) },
      {
        $setOnInsert: {
          jobId: hedgeJobId(job),
          kind: job.kind,
          payload: httpJson(job.payload),
          status: "pending",
          attempts: 0,
          nextRunAt: new Date(),
        },
      },
      { upsert: true, new: true },
    );
  } catch (err) {
    // Concurrent retries can race on MongoDB's unique job identity.
    if (
      !usesPostgres() &&
      (err as { code?: number })?.code === 11000 &&
      (await HedgeJobModel.exists({ jobId: hedgeJobId(job) }))
    )
      return;
    hedgeLogger.error("outbox-push-failed", { kind: job.kind });
    throw new Error("durable-queue-unavailable", { cause: err });
  }
}

export const queue = {
  async push(job: Job): Promise<void> {
    hedgeJobId(job);
    const q = queueFor(job.kind);
    if (!q) {
      await fallback(job);
      return;
    }
    try {
      await q.add(job.kind, httpJson(job.payload), { ...defaults, jobId: hedgeJobId(job) });
    } catch {
      hedgeLogger.error("queue-push-failed", { kind: job.kind });
      await fallback(job);
    }
  },
  async claim(
    kinds: readonly string[],
  ): Promise<{ id: string; lease: string; attempts: number; job: Job } | undefined> {
    if (kinds.length === 0) return undefined;
    if (!databaseConnected()) return undefined;
    if (usesPostgres()) return postgresQueue.claim(kinds);
    const stale = new Date(Date.now() - 60_000);
    const lease = randomUUID();
    const doc = await HedgeJobModel.findOneAndUpdate(
      {
        kind: { $in: kinds },
        $or: [
          { status: "pending", nextRunAt: { $lte: new Date() } },
          { status: "processing", leaseExpiresAt: { $lte: new Date() } },
          { status: "processing", leaseExpiresAt: { $exists: false }, updatedAt: { $lte: stale } },
        ],
      },
      {
        $set: { status: "processing", lease, leaseExpiresAt: new Date(Date.now() + 60_000) },
        $inc: { attempts: 1 },
      },
      { sort: { createdAt: 1 }, new: true },
    ).lean();
    if (!doc) return undefined;
    return {
      id: String(doc["jobId"]),
      lease,
      attempts: Number(doc["attempts"]),
      job: { kind: String(doc["kind"]), payload: doc["payload"] as Record<string, unknown> },
    };
  },

  async renew(id: string, lease: string): Promise<boolean> {
    if (usesPostgres()) return postgresQueue.renew(id, lease);
    const result = await HedgeJobModel.updateOne(
      { jobId: id, status: "processing", lease, leaseExpiresAt: { $gt: new Date() } },
      { $set: { leaseExpiresAt: new Date(Date.now() + 60_000) } },
    );
    return result.modifiedCount === 1;
  },

  async complete(id: string, lease: string): Promise<boolean> {
    if (usesPostgres()) return postgresQueue.complete(id, lease);
    const result = await HedgeJobModel.deleteOne({
      jobId: id,
      status: "processing",
      lease,
      leaseExpiresAt: { $gt: new Date() },
    });
    return result.deletedCount === 1;
  },

  async retry(id: string, lease: string, attempts: number): Promise<void> {
    if (usesPostgres()) return postgresQueue.retry(id, lease, attempts);
    const delay = Math.min(300_000, 2000 * 2 ** Math.min(8, Math.max(0, attempts - 1)));
    await HedgeJobModel.updateOne(
      { jobId: id, status: "processing", lease, leaseExpiresAt: { $gt: new Date() } },
      {
        $set: { status: "pending", nextRunAt: new Date(Date.now() + delay) },
        $unset: { lease: 1, leaseExpiresAt: 1 },
      },
    );
  },
};
