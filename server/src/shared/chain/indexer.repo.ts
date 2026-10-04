import { randomUUID } from "node:crypto";
import { HedgeEventModel, HedgeIndexCursorModel } from "./indexer.model.js";
import { usesPostgres } from "../database/database.client.js";
import { postgresIndex } from "./postgres-index.js";
import { httpJson } from "../http/http.serialization.js";

export type IndexCursor = { nextBlock: string; lastBlockHash?: string; lease: string };
const leaseMs = 180_000;
export const hedgeIndexerRepo = {
  async claim(key: string, start: bigint): Promise<IndexCursor | null> {
    if (usesPostgres()) return postgresIndex.claim(key, start);
    try {
      await HedgeIndexCursorModel.updateOne(
        { _id: key },
        { $setOnInsert: { nextBlock: start.toString() } },
        { upsert: true },
      );
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
    }
    const row = await HedgeIndexCursorModel.findOneAndUpdate(
      {
        _id: key,
        integrityFailure: { $exists: false },
        $or: [{ leaseExpiresAt: { $lte: new Date() } }, { leaseExpiresAt: { $exists: false } }],
      },
      { $set: { lease: randomUUID(), leaseExpiresAt: new Date(Date.now() + leaseMs) } },
      { new: true },
    ).lean();
    if (!row) return null;
    return {
      nextBlock: String(row["nextBlock"]),
      lease: String(row["lease"]),
      ...(row["lastBlockHash"] ? { lastBlockHash: String(row["lastBlockHash"]) } : {}),
    };
  },
  async renew(key: string, lease: string): Promise<boolean> {
    if (usesPostgres()) return postgresIndex.renew(key, lease);
    const result = await HedgeIndexCursorModel.updateOne(
      {
        _id: key,
        lease,
        leaseExpiresAt: { $gt: new Date() },
        integrityFailure: { $exists: false },
      },
      { $set: { leaseExpiresAt: new Date(Date.now() + leaseMs) } },
    );
    return result.modifiedCount === 1;
  },
  async record(id: string, event: Record<string, unknown>): Promise<void> {
    if (usesPostgres()) return postgresIndex.record(id, event);
    try {
      await HedgeEventModel.updateOne(
        { _id: id },
        { $setOnInsert: httpJson(event) as Record<string, unknown> },
        { upsert: true },
      );
    } catch (error) {
      if (
        (error as { code?: number }).code !== 11000 ||
        !(await HedgeEventModel.exists({ _id: id }))
      )
        throw error;
    }
  },
  async advance(
    key: string,
    lease: string,
    nextBlock: bigint,
    lastBlockHash: string,
  ): Promise<void> {
    if (usesPostgres()) return postgresIndex.advance(key, lease, nextBlock, lastBlockHash);
    const result = await HedgeIndexCursorModel.updateOne(
      {
        _id: key,
        lease,
        leaseExpiresAt: { $gt: new Date() },
        integrityFailure: { $exists: false },
      },
      { $set: { nextBlock: nextBlock.toString(), lastBlockHash, indexedAt: new Date() } },
    );
    if (result.modifiedCount !== 1) throw new Error("indexer-lease-lost");
  },
  async integrityFailure(key: string, lease: string): Promise<void> {
    if (usesPostgres()) return postgresIndex.integrityFailure(key, lease);
    await HedgeIndexCursorModel.updateOne(
      { _id: key, lease },
      { $set: { integrityFailure: "finalized-block-changed" } },
    );
  },
  async release(key: string, lease: string): Promise<void> {
    if (usesPostgres()) return postgresIndex.release(key, lease);
    await HedgeIndexCursorModel.updateOne(
      { _id: key, lease },
      { $unset: { lease: 1, leaseExpiresAt: 1 } },
    );
  },
};
