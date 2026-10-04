import { existsSync, lstatSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { sameAddress } from "@hedge/sdk";
import {
  liquidityJournalSchema,
  type LiquidityJournal,
  type LiquidityStore,
} from "../server/src/features/operator/liquidity.schema.js";

export async function migrateLiquidityRecords(
  root: string,
  instance: string,
  operator: string,
  store: LiquidityStore,
  archive: (journal: LiquidityJournal) => Promise<void>,
): Promise<void> {
  const directory = join(root, ".hedge/liquidity");
  if (!existsSync(directory)) return;
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink())
    throw new Error("Refusing symlinked liquidity recovery directory");
  const read = (path: string) => {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
      throw new Error("Legacy liquidity records must be private regular files");
    return liquidityJournalSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  };
  for (const name of readdirSync(directory)) {
    if (!/^[\da-f-]{36}\.json$/i.test(name)) continue;
    await archive(read(join(directory, name)));
  }
  const path = join(directory, "active.json");
  if (!existsSync(path)) return;
  const previous = read(path);
  if (previous.instance !== instance || !sameAddress(previous.operator, operator))
    throw new Error(
      "Select the original deployment/operator to migrate the pending liquidity operation",
    );
  const current = await store.read();
  if (
    current &&
    (current.id !== previous.id ||
      current.action !== previous.action ||
      current.amount !== previous.amount ||
      current.instance !== previous.instance ||
      !sameAddress(current.operator, previous.operator) ||
      !sameAddress(current.token, previous.token))
  )
    throw new Error(
      "Database and local liquidity recovery records conflict; no transaction was sent",
    );
  if (!current) await store.save(previous);
  const backup = join(directory, `${previous.id}.imported.json`);
  if (existsSync(backup))
    throw new Error("Legacy liquidity backup already exists; retained both recovery records");
  renameSync(path, backup);
}

export async function databaseStore(root: string, instance: string, operator: string) {
  const { acquireLiquidityStore, liquidityScope, archiveLiquidityJournal } = await import(
    "../server/src/features/operator/liquidity.repo.js"
  );
  const { assertServerConfig, env } = await import("../server/src/shared/config/env.js");
  const { connectDatabase, closeDatabase } = await import(
    "../server/src/shared/database/database.client.js"
  );
  assertServerConfig();
  if (env.databaseDriver === "none")
    throw new Error(
      "Set DATABASE_DRIVER=mongodb or postgres and DATABASE_URL before changing liquidity",
    );
  let store: Awaited<ReturnType<typeof acquireLiquidityStore>> | undefined;
  const close = async () => {
    try {
      await store?.close();
    } finally {
      await closeDatabase();
    }
  };
  try {
    await connectDatabase();
    store = await acquireLiquidityStore(liquidityScope(instance, operator));
    await migrateLiquidityRecords(root, instance, operator, store, archiveLiquidityJournal);
    return { store, close };
  } catch (error) {
    await close();
    throw error;
  }
}
