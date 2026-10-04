import { afterEach, describe, expect, it, vi } from "vitest";
import type { EvmHedgeReader } from "@hedge/sdk";
import { deploymentConfigSchema } from "@hedge/schema";
import { testRecord } from "../../schema/test/config-fixture";
import { RuntimeWallet, type RuntimeProfile } from "../src/runtime/wallet-service";

const address = `0x${"1".repeat(40)}`;
function fixture() {
  let accounts = [address];
  let chainId = "0x128";
  const listeners = new Map<string, () => void>();
  const provider = {
    request: vi.fn(
      async ({ method, params }: { method: string; params?: { chainId: string }[] }) => {
        if (method === "eth_requestAccounts" || method === "eth_accounts") return accounts;
        if (method === "wallet_switchEthereumChain") {
          chainId = params![0].chainId;
          return null;
        }
        if (method === "eth_chainId") return chainId;
        throw new Error(`Unexpected wallet method: ${method}`);
      },
    ),
    on: vi.fn((event: string, listener: () => void) => listeners.set(event, listener)),
    removeListener: vi.fn((event: string) => listeners.delete(event)),
  };
  vi.stubGlobal("window", { ethereum: provider });
  const config = deploymentConfigSchema.parse(structuredClone(testRecord));
  const profile = { config } as RuntimeProfile;
  const reader = { config: { resolveAccount: async () => "0.0.123" } } as unknown as EvmHedgeReader;
  const wallet = new RuntimeWallet(profile, reader, "injected", vi.fn());
  return {
    wallet,
    provider,
    listeners,
    changeAccounts: (values: string[]) => {
      accounts = values;
    },
  };
}
afterEach(() => vi.unstubAllGlobals());

describe("shared demo wallet state", () => {
  it("notifies the app and Hedge after connection, account changes and disconnect", async () => {
    const f = fixture();
    const app = vi.fn(),
      hedge = vi.fn();
    const stopApp = f.wallet.subscribe(app),
      stopHedge = f.wallet.subscribe(hedge);
    const connected = await f.wallet.connect("hedera");
    expect(await f.wallet.wallet("hedera")).toEqual(connected);
    expect(app).toHaveBeenCalledOnce();
    expect(hedge).toHaveBeenCalledOnce();
    f.changeAccounts([`0x${"2".repeat(40)}`]);
    f.listeners.get("accountsChanged")!();
    expect(await f.wallet.wallet("hedera")).toBeNull();
    expect(app).toHaveBeenCalledTimes(2);
    await f.wallet.connect("hedera");
    f.listeners.get("disconnect")!();
    expect(await f.wallet.wallet("hedera")).toBeNull();
    stopApp();
    expect(f.provider.removeListener).not.toHaveBeenCalled();
    stopHedge();
    expect(f.provider.removeListener).toHaveBeenCalledTimes(2);
    expect(f.listeners.size).toBe(0);
  });
  it("rejects an old selected account even when it remains in the authorized account list", async () => {
    const f = fixture();
    const changed = vi.fn();
    const stop = f.wallet.subscribe(changed);
    await f.wallet.connect("hedera");
    f.changeAccounts([`0x${"2".repeat(40)}`, address]);
    expect(await f.wallet.wallet("hedera")).toBeNull();
    expect(changed).toHaveBeenCalledTimes(2);
    stop();
  });
});
