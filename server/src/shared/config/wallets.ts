import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import { addressSchema } from "@hedge/schema";

const walletSchema = z.strictObject({
  address: addressSchema,
  private_key: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
});
export type StoredWallet = z.infer<typeof walletSchema>;
export type Wallets = { hedera: StoredWallet; base: StoredWallet };

export function validateWallet(value: unknown): StoredWallet {
  try {
    const wallet = walletSchema.parse(value);
    const account = privateKeyToAccount(wallet.private_key as `0x${string}`);
    if (account.address.toLowerCase() !== wallet.address.toLowerCase()) throw new Error();
    return { address: account.address, private_key: wallet.private_key };
  } catch {
    throw new Error("Wallet address and private key must match in .hedge/wallets.json");
  }
}

export function readWallets(root: string): Wallets {
  const directory = join(root, ".hedge");
  const path = join(directory, "wallets.json");
  const dir = lstatSync(directory);
  if (!dir.isDirectory() || dir.isSymbolicLink()) throw new Error("Use a private .hedge directory");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.size > 16_384)
      throw new Error(".hedge/wallets.json must be a private regular file with permissions 0600");
    let value: { hedera: unknown; base: unknown };
    try {
      value = z
        .strictObject({ hedera: z.unknown(), base: z.unknown() })
        .parse(JSON.parse(readFileSync(fd, "utf8")));
    } catch {
      throw new Error("Invalid .hedge/wallets.json; expected Hedera and Base wallets");
    }
    const wallets = { hedera: validateWallet(value.hedera), base: validateWallet(value.base) };
    if (wallets.hedera.address.toLowerCase() === wallets.base.address.toLowerCase())
      throw new Error("Use separate Hedera operator and Base relay wallets");
    return wallets;
  } finally {
    closeSync(fd);
  }
}
