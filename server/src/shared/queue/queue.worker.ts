import { env } from "../config/env.js";
import { Worker } from "bullmq";
import { duplicateRedis, queue, redisConnection } from "./queue.client.js";
import { hedgeLogger } from "../logging/hedge-logger.js";

export type Handler = (job: { kind: string; payload: Record<string, unknown> }) => Promise<void>;
const handlers = new Map<string, Handler>();
const workers: Worker[] = [];

export function registerHandler(kinds: string[], fn: Handler): void {
  if (workers.length) throw new Error("workers-already-started");
  for (const kind of kinds) {
    if (handlers.has(kind)) throw new Error("handler-already-registered");
    handlers.set(kind, fn);
  }
}

export async function drainQueue(handle: Handler, kinds: readonly string[]): Promise<number> {
  let n = 0;
  let claimed = await queue.claim(kinds);
  while (claimed) {
    const current = claimed;
    let leaseLost = false;
    const heartbeat = setInterval(() => {
      void queue
        .renew(current.id, current.lease)
        .then((renewed) => {
          if (!renewed) leaseLost = true;
        })
        .catch((_err: unknown) => {
          leaseLost = true;
          hedgeLogger.error("job-lease-renew-failed", { id: current.id });
        });
    }, 15_000);
    try {
      await handle(current.job);
      if (leaseLost) throw new Error("job-lease-lost");
      if (!(await queue.complete(current.id, current.lease))) throw new Error("job-lease-lost");
      n += 1;
    } catch {
      await queue.retry(current.id, current.lease, current.attempts);
      hedgeLogger.error("job-failed", { kind: current.job.kind });
    } finally {
      clearInterval(heartbeat);
    }
    claimed = await queue.claim(kinds);
  }
  return n;
}

export async function startWorkers(): Promise<void> {
  if (workers.length !== 0) return;
  const conn = redisConnection();
  if (!conn) return;
  for (const [kind, fn] of handlers) {
    const w = new Worker(
      kind,
      async (j) => {
        await fn({ kind: j.name, payload: (j.data ?? {}) as Record<string, unknown> });
      },
      { connection: duplicateRedis()!, prefix: env.redisPrefix, concurrency: 5 },
    );
    w.on("failed", (j, _err) => hedgeLogger.error("worker-failed", { kind, id: j?.id }));
    workers.push(w);
  }
}

export async function stopWorkers(): Promise<void> {
  const results = await Promise.allSettled(workers.map((w) => w.close()));
  for (const result of results) {
    if (result.status === "rejected") hedgeLogger.error("worker-close-failed", {});
  }
  workers.length = 0;
}
