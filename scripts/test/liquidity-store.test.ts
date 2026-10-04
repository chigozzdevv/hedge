import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateLiquidityRecords } from "../liquidity-store.js";
import type {
  LiquidityJournal,
  LiquidityStore,
} from "../../server/src/features/operator/liquidity.schema.js";

let root: string;
let journal: LiquidityJournal;
let current: LiquidityJournal | undefined;
let store: LiquidityStore;
let archive: ReturnType<typeof vi.fn<(journal: LiquidityJournal) => Promise<void>>>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hedge-liquidity-migration-"));
  mkdirSync(join(root, ".hedge/liquidity"), { recursive: true, mode: 0o700 });
  journal = {
    version: 1,
    id: randomUUID(),
    instance: "test-instance",
    operator: `0x${"1".repeat(40)}`,
    token: `0x${"2".repeat(40)}`,
    action: "deposit",
    amount: "1000000",
    status: "pending",
    calls: [],
    hashes: {},
  };
  current = undefined;
  store = {
    read: async () => current,
    save: async (value) => {
      current = structuredClone(value);
    },
    complete: async () => undefined,
    assertOwned: async () => undefined,
  };
  archive = vi.fn(async () => undefined);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const migrate = () =>
  migrateLiquidityRecords(root, journal.instance, journal.operator, store, archive);
const active = () => join(root, ".hedge/liquidity/active.json");
describe("liquidity database migration", () => {
  it("imports pending operations and completed receipts while retaining private backups", async () => {
    writeFileSync(active(), JSON.stringify(journal), { mode: 0o600 });
    const receipt = { ...journal, id: randomUUID(), status: "complete" } as LiquidityJournal;
    const path = join(root, ".hedge/liquidity", `${receipt.id}.json`);
    writeFileSync(path, JSON.stringify(receipt), { mode: 0o600 });
    await migrate();
    expect(current).toEqual(journal);
    expect(archive).toHaveBeenCalledWith(receipt);
    expect(existsSync(active())).toBe(false);
    expect(
      readFileSync(join(root, ".hedge/liquidity", `${journal.id}.imported.json`), "utf8"),
    ).toBe(JSON.stringify(journal));
    expect(existsSync(path)).toBe(true);
  });
  it("retains the original recovery file when the database write fails", async () => {
    writeFileSync(active(), JSON.stringify(journal), { mode: 0o600 });
    store.save = async () => {
      throw new Error("Database unavailable");
    };
    await expect(migrate()).rejects.toThrow("Database unavailable");
    expect(readFileSync(active(), "utf8")).toBe(JSON.stringify(journal));
  });
  it("refuses conflicting operations and another deployment's pending transaction", async () => {
    writeFileSync(active(), JSON.stringify(journal), { mode: 0o600 });
    current = { ...journal, id: randomUUID() };
    await expect(migrate()).rejects.toThrow("conflict");
    current = undefined;
    await expect(
      migrateLiquidityRecords(root, "other-instance", journal.operator, store, archive),
    ).rejects.toThrow("original deployment/operator");
    expect(existsSync(active())).toBe(true);
  });
});
