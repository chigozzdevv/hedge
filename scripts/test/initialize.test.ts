import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialize } from "../initialize.js";
import { privateKeyToAccount } from "viem/accounts";

const folders: string[] = [];
function workspace() {
  const root = mkdtempSync(join(tmpdir(), "hedge-init-"));
  folders.push(root);
  return root;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

describe("operator initialization", () => {
  it("creates matching wallet keys without creating settings or using OS key storage", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const root = workspace();
    const wallets = await initialize(root);
    for (const name of ["hedera", "base"] as const)
      expect(privateKeyToAccount(wallets[name].private_key as `0x${string}`).address).toBe(
        wallets[name].address,
      );
    expect(wallets.hedera.address).not.toBe(wallets.base.address);
    expect(statSync(join(root, ".hedge/wallets.json")).mode & 0o777).toBe(0o600);
    expect(existsSync(join(root, ".env"))).toBe(false);
    expect(existsSync(join(root, "operator.json"))).toBe(false);
    expect(existsSync(join(root, "deployments"))).toBe(false);
    expect(existsSync(join(root, "hedge.config.json"))).toBe(false);
  });
  it("retains supplied public configuration and rules on repeated initialization", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const root = workspace();
    const env = "DATABASE_DRIVER=postgres\nDATABASE_URL=private\n";
    const policy = JSON.stringify({ max_loan_amount: "123", term_days: 7 });
    writeFileSync(join(root, "hedge.config.json"), env);
    writeFileSync(join(root, "operator.json"), policy);
    const wallets = await initialize(root);
    const before = readFileSync(join(root, ".hedge/wallets.json"), "utf8");
    expect(await initialize(root)).toEqual(wallets);
    expect(readFileSync(join(root, ".hedge/wallets.json"), "utf8")).toBe(before);
    expect(readFileSync(join(root, "hedge.config.json"), "utf8")).toBe(env);
    expect(readFileSync(join(root, "operator.json"), "utf8")).toBe(policy);
  });
  it("rejects mismatched addresses, loose permissions and symlinked storage without replacing wallets", async () => {
    const root = workspace();
    const wallets = await initialize(root);
    const path = join(root, ".hedge/wallets.json");
    writeFileSync(
      path,
      JSON.stringify({ ...wallets, hedera: { ...wallets.hedera, address: wallets.base.address } }),
    );
    await expect(initialize(root)).rejects.toThrow("must match");
    writeFileSync(path, JSON.stringify(wallets));
    chmodSync(path, 0o644);
    await expect(initialize(root)).rejects.toThrow("0600");
    chmodSync(path, 0o600);
    const target = join(root, "original.json");
    writeFileSync(target, JSON.stringify(wallets), { mode: 0o600 });
    rmSync(path);
    symlinkSync(target, path);
    await expect(initialize(root)).rejects.toThrow();
  });
  it("refuses to generate new identities over existing wallet storage", async () => {
    const root = workspace();
    mkdirSync(join(root, ".hedge"));
    writeFileSync(join(root, ".hedge/testnet-wallets.json"), "{}");
    await expect(initialize(root)).rejects.toThrow("preserve identities");
    expect(existsSync(join(root, ".hedge/wallets.json"))).toBe(false);
  });
});
