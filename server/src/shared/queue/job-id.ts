import { createHash } from "node:crypto";
import type { Job } from "./queue.client.js";
function canonicalJson(value: unknown): string {
  return (
    JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === "bigint") return item.toString();
      if (item && typeof item === "object" && !Array.isArray(item))
        return Object.fromEntries(
          Object.entries(item).sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0,
          ),
        );
      return item;
    }) ?? "null"
  );
}
export function hedgeJobId(job: Job): string {
  if (
    !/^[a-z][a-z0-9._-]*$/.test(job.kind) ||
    (job.idempotencyKey !== undefined && !job.idempotencyKey.trim())
  )
    throw new Error("job-invalid");
  // A loan ID alone is not an operation ID; independent messages for one loan must stay distinct.
  const identity = job.idempotencyKey ?? job.payload;
  return createHash("sha256")
    .update(canonicalJson(["hedge-job-v1", job.kind, identity]))
    .digest("hex");
}
