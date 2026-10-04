import { randomUUID } from "node:crypto";
import { databaseConnected, usesPostgres } from "../../shared/database/database.client.js";
import { sqlQuery } from "../../shared/database/postgres.js";
import { LiquidityStateModel, LiquidityReceiptModel } from "./liquidity.model.js";
import {
  liquidityJournalSchema,
  type LiquidityJournal,
  type LiquidityStore,
} from "./liquidity.schema.js";

const leaseMs = 120_000;
const lost = () => new Error("Liquidity database lease lost; rerun the original command to resume");
const duplicate = (error: unknown) => (error as { code?: number })?.code === 11000;
export const liquidityScope = (instance: string, operator: string) =>
  `${instance.toLowerCase()}:${operator.toLowerCase()}`;

export async function archiveLiquidityJournal(journal: LiquidityJournal): Promise<void> {
  liquidityJournalSchema.parse(journal);
  if (journal.status === "pending")
    throw new Error("Cannot archive pending liquidity as a receipt");
  const scope = liquidityScope(journal.instance, journal.operator);
  if (usesPostgres())
    await sqlQuery(
      `INSERT INTO hedge_liquidity_receipts(id,scope,journal) VALUES($1,$2,$3::jsonb)
      ON CONFLICT(id) DO NOTHING`,
      [journal.id, scope, JSON.stringify(journal)],
    );
  else
    await LiquidityReceiptModel.updateOne(
      { _id: journal.id },
      { $setOnInsert: { scope, journal } },
      { upsert: true },
    );
}

export async function acquireLiquidityStore(
  scope: string,
): Promise<LiquidityStore & { close(): Promise<void> }> {
  if (!databaseConnected())
    throw new Error("Configure and connect MongoDB/PostgreSQL before changing liquidity");
  const lease = randomUUID();
  let acquired: boolean;
  if (usesPostgres()) {
    acquired =
      (
        await sqlQuery(
          `
      INSERT INTO hedge_liquidity_state(scope,lease,lease_expires_at) VALUES($1,$2,clock_timestamp()+interval '120 seconds')
      ON CONFLICT(scope) DO UPDATE SET lease=$2,lease_expires_at=clock_timestamp()+interval '120 seconds'
      WHERE hedge_liquidity_state.lease IS NULL OR hedge_liquidity_state.lease_expires_at<=clock_timestamp()
      RETURNING scope`,
          [scope, lease],
        )
      ).rowCount === 1;
  } else {
    try {
      await LiquidityStateModel.updateOne(
        { _id: scope },
        { $setOnInsert: { journal: null } },
        { upsert: true },
      );
    } catch (error) {
      if (!duplicate(error)) throw error;
    }
    {
      acquired = !!(await LiquidityStateModel.findOneAndUpdate(
        {
          _id: scope,
          $or: [{ lease: null }, { $expr: { $lte: ["$leaseExpiresAt", "$$NOW"] } }],
        },
        [
          {
            $set: {
              lease,
              leaseExpiresAt: { $add: ["$$NOW", leaseMs] },
              journal: { $ifNull: ["$journal", null] },
            },
          },
        ],
        { returnDocument: "after", updatePipeline: true },
      ));
    }
  }
  if (!acquired) throw new Error("Another liquidity command is running for this operator");
  const filter = () => ({ _id: scope, lease, $expr: { $gt: ["$leaseExpiresAt", "$$NOW"] } });
  let closed = false;
  let failure: unknown;
  let renewing: Promise<void> | undefined;
  const renew = async () => {
    if (closed || failure) throw lost();
    renewing ??= (async () => {
      const count = usesPostgres()
        ? (
            await sqlQuery(
              `UPDATE hedge_liquidity_state SET lease_expires_at=clock_timestamp()+interval '120 seconds'
            WHERE scope=$1 AND lease=$2 AND lease_expires_at>clock_timestamp()`,
              [scope, lease],
            )
          ).rowCount
        : (
            await LiquidityStateModel.updateOne(
              filter(),
              [{ $set: { leaseExpiresAt: { $add: ["$$NOW", leaseMs] } } }],
              { updatePipeline: true },
            )
          ).matchedCount;
      if (count !== 1) throw lost();
    })().catch((error) => {
      failure = error;
      throw error;
    });
    try {
      await renewing;
    } finally {
      renewing = undefined;
    }
  };
  const timer = setInterval(() => {
    void renew().catch(() => undefined);
  }, 30_000);
  timer.unref();
  const save = async (journal: LiquidityJournal | null) => {
    await renew();
    if (journal) liquidityJournalSchema.parse(journal);
    const count = usesPostgres()
      ? (
          await sqlQuery(
            `UPDATE hedge_liquidity_state SET journal=$3::jsonb
          WHERE scope=$1 AND lease=$2 AND lease_expires_at>clock_timestamp()`,
            [scope, lease, JSON.stringify(journal)],
          )
        ).rowCount
      : (await LiquidityStateModel.updateOne(filter(), { $set: { journal } })).matchedCount;
    if (count !== 1) throw lost();
  };
  return {
    assertOwned: renew,
    async read() {
      await renew();
      const journal = usesPostgres()
        ? (
            await sqlQuery(
              "SELECT journal FROM hedge_liquidity_state WHERE scope=$1 AND lease=$2",
              [scope, lease],
            )
          ).rows[0]?.["journal"]
        : (await LiquidityStateModel.findOne(filter()).lean())?.["journal"];
      return journal ? liquidityJournalSchema.parse(journal) : undefined;
    },
    save,
    async complete(journal, status = "complete") {
      journal.status = status;
      await save(journal);
      await archiveLiquidityJournal(journal);
      await save(null);
    },
    async close() {
      closed = true;
      clearInterval(timer);
      await renewing?.catch(() => undefined);
      if (usesPostgres())
        await sqlQuery(
          "UPDATE hedge_liquidity_state SET lease=NULL,lease_expires_at=NULL WHERE scope=$1 AND lease=$2",
          [scope, lease],
        );
      else
        await LiquidityStateModel.updateOne(
          { _id: scope, lease },
          { $unset: { lease: 1, leaseExpiresAt: 1 } },
        );
    },
  };
}
