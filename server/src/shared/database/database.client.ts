import mongoose from "mongoose";
import { env } from "../config/env.js";
import "./records.js";
import "../chain/indexer.model.js";
import "../queue/queue.model.js";
import { closePostgres, connectPostgres, postgresConnected, sqlQuery } from "./postgres.js";
export const usesPostgres = () => env.databaseDriver === "postgres";
export const databaseConnected = () =>
  usesPostgres() ? postgresConnected() : mongoose.connection.readyState === 1;
export async function connectDatabase(url: string = env.databaseUrl): Promise<void> {
  if (!url) throw new Error("database-unconfigured");
  if (usesPostgres()) {
    await connectPostgres(url);
    return;
  }
  if (env.databaseDriver !== "mongodb") throw new Error("database-driver-unconfigured");
  if (mongoose.connection.readyState !== 1)
    await mongoose.connect(url, { serverSelectionTimeoutMS: 5000 });
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
}
export async function closeDatabase(): Promise<void> {
  await closePostgres();
  await mongoose.disconnect();
}
export async function databaseReady(): Promise<boolean> {
  if (env.databaseDriver === "none") return true;
  if (!databaseConnected()) return false;
  if (usesPostgres()) {
    await sqlQuery("SELECT 1");
    return true;
  }
  if (!mongoose.connection.db) return false;
  await mongoose.connection.db.admin().ping();
  return true;
}
