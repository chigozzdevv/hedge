import { env } from "../config/env.js";
import { databaseReady } from "../database/database.client.js";
import { redisConnection } from "../queue/queue.client.js";
/** Checks configured infrastructure only. This is not a protocol/deployment readiness assertion. */
export async function serverReadiness(): Promise<boolean> {
  if (!(await databaseReady())) return false;
  if (env.redisUrl) {
    const connection = redisConnection();
    if (!connection || (await connection.ping()) !== "PONG") return false;
  }
  return true;
}
