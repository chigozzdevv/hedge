import { chmodSync, existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { readWallets, type Wallets } from "../server/src/shared/config/wallets.js";

export async function initialize(root: string): Promise<Wallets> {
  const directory = join(root, ".hedge");
  const path = join(directory, "wallets.json");
  if (existsSync(path) || (existsSync(directory) && lstatSync(directory).isSymbolicLink()))
    return readWallets(root);
  if (existsSync(join(directory, "testnet-wallets.json")) || existsSync(join(directory, "keys")))
    throw new Error(
      "Existing wallet storage found; migrate it before initializing to preserve identities",
    );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const wallet = () => {
    const private_key = generatePrivateKey();
    return { address: privateKeyToAccount(private_key).address, private_key };
  };
  const wallets = { hedera: wallet(), base: wallet() };
  writeFileSync(path, JSON.stringify(wallets, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return readWallets(root);
}
