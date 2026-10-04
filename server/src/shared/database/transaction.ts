import mongoose from "mongoose";
import type { PoolClient } from "pg";
import { usesPostgres } from "./database.client.js";
import { sqlTransaction } from "./postgres.js";

export async function withDatabaseTransaction<T>(
  fn: (session: mongoose.ClientSession | PoolClient) => Promise<T>,
): Promise<T> {
  if (usesPostgres()) return sqlTransaction(fn);
  const session = await mongoose.startSession();
  try {
    let out: T | undefined;
    await session.withTransaction(async () => {
      out = await fn(session);
    });
    return out as T;
  } finally {
    await session.endSession();
  }
}
