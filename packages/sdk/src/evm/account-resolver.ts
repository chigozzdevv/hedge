import { accountIdSchema, addressSchema } from "@hedge/schema";
import { HedgeError } from "../client/hedge-error";
import { sameAddress } from "./address";

/** Verify both EVM aliases and numeric account addresses against the selected mirror node. */
export function createAccountResolver(mirrorUrl: string) {
  const endpoint = new URL(mirrorUrl).href.replace(/\/$/, "");
  const accounts = new Map<string, Promise<string>>();
  return (address: string): Promise<string> => {
    const key = addressSchema.parse(address).toLowerCase();
    const cached = accounts.get(key);
    if (cached) return cached;
    const lookup = (async () => {
      const response = await fetch(`${endpoint}/api/v1/accounts/${key}`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok)
        throw new HedgeError("WALLET_UNAVAILABLE", "Hedera account could not be resolved");
      const account = (await response.json()) as {
        account?: unknown;
        evm_address?: unknown;
        deleted?: unknown;
      };
      if (
        !account ||
        typeof account.account !== "string" ||
        !accountIdSchema.safeParse(account.account).success ||
        account.deleted !== false ||
        !(account.evm_address === null || typeof account.evm_address === "string")
      )
        throw new HedgeError("WALLET_MISMATCH", "Hedera account identity is invalid");
      const numericAddress = `0x${BigInt(account.account.split(".")[2]).toString(16).padStart(40, "0")}`;
      if (!sameAddress(account.evm_address ?? "", key) && !sameAddress(numericAddress, key))
        throw new HedgeError("WALLET_MISMATCH", "Hedera account and EVM address differ");
      return account.account;
    })().catch((error: unknown) => {
      accounts.delete(key);
      throw error;
    });
    accounts.set(key, lookup);
    return lookup;
  };
}
