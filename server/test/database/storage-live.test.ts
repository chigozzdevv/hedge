import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env, assertServerConfig } from "../../src/shared/config/env.js";
import {
  connectDatabase,
  closeDatabase,
  databaseReady,
  usesPostgres,
} from "../../src/shared/database/database.client.js";
import mongoose from "mongoose";
import {
  readRecord,
  writeRecord,
  createRecord,
  withRecordLease,
} from "../../src/shared/database/records.js";
import { sqlQuery, sqlTransaction } from "../../src/shared/database/postgres.js";
import { creditRepo } from "../../src/features/credit/credit.repo.js";
import { collateralRepo } from "../../src/features/collateral/collateral.repo.js";
import { offerRepo } from "../../src/features/offer/offer.repo.js";
import { HedgeCreditModel } from "../../src/features/credit/credit.model.js";
import { HedgeCollateralModel } from "../../src/features/collateral/collateral.model.js";
import { HedgeOfferModel } from "../../src/features/offer/offer.model.js";
import { HedgeJobModel } from "../../src/shared/queue/queue.model.js";
import { HedgeIndexCursorModel, HedgeEventModel } from "../../src/shared/chain/indexer.model.js";
import { queue } from "../../src/shared/queue/queue.client.js";
import { hedgeJobId } from "../../src/shared/queue/job-id.js";
import { hedgeIndexerRepo } from "../../src/shared/chain/indexer.repo.js";
import {
  acquireLiquidityStore,
  liquidityScope,
} from "../../src/features/operator/liquidity.repo.js";
import {
  LiquidityStateModel,
  LiquidityReceiptModel,
} from "../../src/features/operator/liquidity.model.js";
import type { LiquidityJournal } from "../../src/features/operator/liquidity.schema.js";
import type { Hex } from "viem";
import {
  credit,
  collateral,
  offer,
  observed,
  hash,
  address,
} from "../chain/hedge-reader.fixture.js";

const live = process.env["HEDGE_STORAGE_TEST"] === "1";
const prefix = `storage-${randomUUID()}`;
const instance = prefix;
const kind = `storage.${randomUUID()}`;
const cursor = `${prefix}:cursor`;
const job = { kind, payload: { instance, amount: 9007199254740993123n }, idempotencyKey: prefix };
const jobId = hedgeJobId(job);

describe.skipIf(!live)(`real ${env.databaseDriver} storage`, () => {
  beforeAll(async () => {
    assertServerConfig();
    // Explicit opt-in and dedicated throwaway endpoints prevent accidental live DB tests.
    const url = new URL(env.databaseUrl);
    if (
      url.hostname !== "127.0.0.1" ||
      url.pathname !== "/hedge_test" ||
      !["15432", "27027"].includes(url.port) ||
      env.redisUrl
    )
      throw new Error(
        "Storage tests require the isolated loopback hedge_test database and no Redis",
      );
    await Promise.all([connectDatabase(), connectDatabase()]);
    expect(await databaseReady()).toBe(true);
  });
  afterAll(async () => {
    if (usesPostgres()) {
      for (const table of ["hedge_credits", "hedge_collateral", "hedge_offers"])
        await sqlQuery(`DELETE FROM ${table} WHERE instance_id=$1 OR instance_id=$2`, [
          instance,
          `${instance}-other`,
        ]);
      await sqlQuery("DELETE FROM hedge_jobs WHERE kind=$1", [kind]);
      await sqlQuery("DELETE FROM hedge_records WHERE scope=$1", [prefix]);
      await sqlQuery("DELETE FROM hedge_record_leases WHERE scope=$1", [prefix]);
      for (const table of ["hedge_liquidity_state", "hedge_liquidity_receipts"])
        await sqlQuery(`DELETE FROM ${table} WHERE scope LIKE $1`, [`${prefix}:%`]);
      await sqlQuery("DELETE FROM hedge_index_cursors WHERE id=$1", [cursor]);
      await sqlQuery("DELETE FROM hedge_chain_events WHERE id=ANY($1::text[])", [
        [prefix, `${prefix}:rollback`],
      ]);
    } else {
      for (const model of [HedgeCreditModel, HedgeCollateralModel, HedgeOfferModel])
        await model.deleteMany({ instanceId: { $in: [instance, `${instance}-other`] } });
      await HedgeJobModel.deleteMany({ kind });
      await mongoose.models["HedgeRecord"]!.deleteMany({ scope: prefix });
      await mongoose.models["HedgeRecordLease"]!.deleteOne({ _id: prefix });
      await LiquidityStateModel.deleteMany({ _id: { $regex: `^${prefix}:` } });
      await LiquidityReceiptModel.deleteMany({ scope: { $regex: `^${prefix}:` } });
      await HedgeIndexCursorModel.deleteOne({ _id: cursor });
      await HedgeEventModel.deleteOne({ _id: prefix });
    }
    await closeDatabase();
  });

  it("persists runtime records across restarts and keeps the first racing signature", async () => {
    await writeRecord(prefix, "services", { server: { pid: 42 } });
    const signatures = await Promise.all(
      Array.from({ length: 8 }, (_, n) => createRecord(prefix, "signed", { hash: `hash-${n}` })),
    );
    expect(new Set(signatures.map((value) => value.hash)).size).toBe(1);
    await closeDatabase();
    await connectDatabase();
    expect(await readRecord(prefix, "services")).toEqual({ server: { pid: 42 } });
    expect(await readRecord(prefix, "signed")).toEqual(signatures[0]);
  });

  it("rejects concurrent wallet signers and fences an expired database lease", async () => {
    await withRecordLease(prefix, async (assertOwned) => {
      await expect(withRecordLease(prefix, async () => undefined)).rejects.toThrow(
        "Another command",
      );
      await assertOwned();
      if (usesPostgres())
        await sqlQuery(
          "UPDATE hedge_record_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE scope=$1",
          [prefix],
        );
      else
        await mongoose.models["HedgeRecordLease"]!.updateOne(
          { _id: prefix },
          { $set: { expiresAt: new Date(0) } },
        );
      await withRecordLease(prefix, async (newOwner) => {
        await newOwner();
        await expect(assertOwned()).rejects.toThrow("lease lost");
      });
    });
    await expect(
      withRecordLease(prefix, async (assertOwned) => assertOwned()),
    ).resolves.toBeUndefined();
  });

  it("persists all feature observations without losing integer precision or mixing instances", async () => {
    await creditRepo.save(
      observed({ ...credit, instance_id: instance, amount_due: job.payload.amount }),
    );
    await creditRepo.save(observed({ ...credit, instance_id: `${instance}-other` }));
    await collateralRepo.save(observed({ ...collateral, instance_id: instance }, "base"));
    await offerRepo.save(observed({ ...offer, instance_id: instance }));
    if (usesPostgres()) {
      const rows = (
        await sqlQuery("SELECT snapshot FROM hedge_credits WHERE instance_id=$1", [instance])
      ).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.["snapshot"].amount_due).toBe(job.payload.amount.toString());
      for (const table of ["hedge_collateral", "hedge_offers"])
        expect(
          (await sqlQuery(`SELECT id FROM ${table} WHERE instance_id=$1`, [instance])).rowCount,
        ).toBe(1);
    } else {
      const row = await HedgeCreditModel.findOne({ instanceId: instance }).lean();
      expect(row?.["snapshot"].amount_due).toBe(job.payload.amount.toString());
      expect(
        await HedgeCreditModel.countDocuments({
          instanceId: { $in: [instance, `${instance}-other`] },
        }),
      ).toBe(2);
      expect(await HedgeCollateralModel.countDocuments({ instanceId: instance })).toBe(1);
      expect(await HedgeOfferModel.countDocuments({ instanceId: instance })).toBe(1);
    }
  });

  it("retains the newest racing observation and rejects a conflicting block hash", async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, n) =>
        creditRepo.save({
          ...observed({ ...credit, instance_id: instance }),
          observedBlock: 101 + n,
        }),
      ),
    );
    const row = usesPostgres()
      ? (
          await sqlQuery("SELECT observed_block FROM hedge_credits WHERE instance_id=$1", [
            instance,
          ])
        ).rows[0]
      : await HedgeCreditModel.findOne({ instanceId: instance }).lean();
    expect(String(row?.[usesPostgres() ? "observed_block" : "observedBlock"])).toBe("110");
    await expect(
      creditRepo.save({
        ...observed({ ...credit, instance_id: instance }),
        observedBlock: 110,
        observedHash: `0x${"3".repeat(64)}`,
      }),
    ).rejects.toThrow();
  });

  it("deduplicates concurrent outbox inserts and grants one processing lease", async () => {
    await Promise.all(Array.from({ length: 8 }, () => queue.push(job)));
    const claims = await Promise.all(Array.from({ length: 8 }, () => queue.claim([kind])));
    const leases = claims.filter((value) => value !== undefined);
    expect(leases).toHaveLength(1);
    const claim = leases[0]!;
    expect(claim.job.payload["amount"]).toBe(job.payload.amount.toString());
    expect(await queue.renew(jobId, "wrong-lease")).toBe(false);
    expect(await queue.complete(jobId, "wrong-lease")).toBe(false);
    await queue.retry(jobId, "wrong-lease", 1);
    expect(await queue.renew(jobId, claim.lease)).toBe(true);
    if (usesPostgres())
      await sqlQuery(
        "UPDATE hedge_jobs SET lease_expires_at=CURRENT_TIMESTAMP-interval '1 second' WHERE job_id=$1",
        [jobId],
      );
    else
      await HedgeJobModel.updateOne(
        { jobId },
        { $set: { leaseExpiresAt: new Date(Date.now() - 1000) } },
      );
    expect(await queue.complete(jobId, claim.lease)).toBe(false);
    expect(await queue.renew(jobId, claim.lease)).toBe(false);
    const resumed = await queue.claim([kind]);
    expect(resumed?.attempts).toBe(2);
    expect(resumed?.lease).not.toBe(claim.lease);
    await queue.retry(jobId, resumed!.lease, resumed!.attempts);
    expect(await queue.claim([kind])).toBeUndefined();
  });

  it("keeps retry timing and observations across a connection restart", async () => {
    await closeDatabase();
    await connectDatabase();
    expect(await databaseReady()).toBe(true);
    expect(await queue.claim([kind])).toBeUndefined();
    if (usesPostgres())
      await sqlQuery(
        "UPDATE hedge_jobs SET next_run_at=CURRENT_TIMESTAMP-interval '1 second' WHERE job_id=$1",
        [jobId],
      );
    else
      await HedgeJobModel.updateOne(
        { jobId },
        { $set: { nextRunAt: new Date(Date.now() - 1000) } },
      );
    const resumed = await queue.claim([kind]);
    expect(resumed?.attempts).toBe(3);
    expect(await queue.complete(jobId, resumed!.lease)).toBe(true);
    expect(await queue.claim([kind])).toBeUndefined();
    const row = usesPostgres()
      ? (
          await sqlQuery("SELECT observed_block FROM hedge_credits WHERE instance_id=$1", [
            instance,
          ])
        ).rows[0]
      : await HedgeCreditModel.findOne({ instanceId: instance }).lean();
    expect(String(row?.[usesPostgres() ? "observed_block" : "observedBlock"])).toBe("110");
  });

  it("owns index cursors exclusively, resumes position and halts after an integrity failure", async () => {
    const claims = await Promise.all(
      Array.from({ length: 8 }, () => hedgeIndexerRepo.claim(cursor, 100n)),
    );
    const leases = claims.filter((value) => value !== null);
    expect(leases).toHaveLength(1);
    const lease = leases[0]!.lease;
    expect(await hedgeIndexerRepo.renew(cursor, "wrong-lease")).toBe(false);
    await expect(hedgeIndexerRepo.advance(cursor, "wrong-lease", 101n, hash)).rejects.toThrow(
      "indexer-lease-lost",
    );
    await hedgeIndexerRepo.advance(cursor, lease, 101n, hash);
    await hedgeIndexerRepo.release(cursor, lease);
    await closeDatabase();
    await connectDatabase();
    const resumed = await hedgeIndexerRepo.claim(cursor, 0n);
    expect(resumed).toMatchObject({ nextBlock: "101", lastBlockHash: hash });
    await hedgeIndexerRepo.integrityFailure(cursor, resumed!.lease);
    expect(await hedgeIndexerRepo.renew(cursor, resumed!.lease)).toBe(false);
    await expect(hedgeIndexerRepo.advance(cursor, resumed!.lease, 102n, hash)).rejects.toThrow(
      "indexer-lease-lost",
    );
    await hedgeIndexerRepo.release(cursor, resumed!.lease);
    expect(await hedgeIndexerRepo.claim(cursor, 0n)).toBeNull();
  });

  it("records a canonical event once and serializes exact integers", async () => {
    const event = {
      chainId: 296,
      contract: address,
      block: "101",
      blockHash: hash,
      txHash: hash,
      logIndex: 0,
      event: "Funded",
      data: { amount: job.payload.amount },
    };
    await Promise.all(Array.from({ length: 8 }, () => hedgeIndexerRepo.record(prefix, event)));
    await hedgeIndexerRepo.record(prefix, { ...event, event: "Changed" });
    const row = usesPostgres()
      ? (await sqlQuery("SELECT event FROM hedge_chain_events WHERE id=$1", [prefix])).rows[0]?.[
          "event"
        ]
      : await HedgeEventModel.findById(prefix).lean();
    expect(row?.event).toBe("Funded");
    expect(row?.data.amount).toBe(job.payload.amount.toString());
  });

  it.skipIf(env.databaseDriver !== "postgres")(
    "rolls back a failed PostgreSQL transaction on the same client",
    async () => {
      await expect(
        sqlTransaction(async (client) => {
          await client.query("INSERT INTO hedge_chain_events(id,event) VALUES($1,$2)", [
            `${prefix}:rollback`,
            "{}",
          ]);
          throw new Error("intentional-rollback");
        }),
      ).rejects.toThrow("intentional-rollback");
      expect(
        (await sqlQuery("SELECT id FROM hedge_chain_events WHERE id=$1", [`${prefix}:rollback`]))
          .rowCount,
      ).toBe(0);
      expect((await sqlQuery("SELECT id FROM hedge_migrations")).rowCount).toBe(7);
    },
  );
  it("stores signed liquidity recovery across connection restarts and archives confirmed receipts", async () => {
    const scope = liquidityScope(instance, address);
    const journal: LiquidityJournal = {
      version: 1,
      id: randomUUID(),
      instance,
      operator: address,
      token: address,
      action: "deposit",
      amount: "9007199254740993123",
      status: "pending",
      calls: [{ to: address as Hex, data: "0xab", serialized: "0xabcd", hash: hash as Hex }],
      hashes: { deposit: hash as Hex },
    };
    const store = await acquireLiquidityStore(scope);
    await store.save(journal);
    await expect(acquireLiquidityStore(scope)).rejects.toThrow("Another liquidity");
    await store.close();
    await closeDatabase();
    await connectDatabase();
    const resumed = await acquireLiquidityStore(scope);
    expect(await resumed.read()).toEqual(journal);
    await resumed.complete(journal);
    expect(await resumed.read()).toBeUndefined();
    await resumed.close();
    const receipt = usesPostgres()
      ? (await sqlQuery("SELECT journal FROM hedge_liquidity_receipts WHERE id=$1", [journal.id]))
          .rows[0]?.["journal"]
      : (await LiquidityReceiptModel.findById(journal.id).lean())?.["journal"];
    expect(receipt).toEqual({ ...journal, status: "complete" });
  });
  it("grants one liquidity lease across racing hosts and fences an expired signer", async () => {
    const scope = liquidityScope(instance, `0x${"7".repeat(40)}`);
    const claims = await Promise.allSettled(
      Array.from({ length: 6 }, () => acquireLiquidityStore(scope)),
    );
    const winners = claims.filter((claim) => claim.status === "fulfilled");
    expect(winners).toHaveLength(1);
    const first = winners[0].value;
    if (usesPostgres())
      await sqlQuery(
        "UPDATE hedge_liquidity_state SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE scope=$1",
        [scope],
      );
    else
      await LiquidityStateModel.updateOne(
        { _id: scope },
        { $set: { leaseExpiresAt: new Date(Date.now() - 1000) } },
      );
    await expect(first.assertOwned()).rejects.toThrow("lease lost");
    const second = await acquireLiquidityStore(scope);
    await first.close();
    await second.assertOwned();
    await second.close();
  });
});
