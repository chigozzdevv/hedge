import {
  createWalletClient,
  custom,
  defineChain,
  type EIP1193Provider,
  type Address,
  type Hex,
} from "viem";
import type {
  EvmWallet,
  WalletIdentity,
  EvmTransaction,
  Chain,
  EvmHedgeReader,
  ClientConfig,
} from "@hedge/sdk";
import { sameAddress } from "@hedge/sdk";

export interface RuntimeProfile {
  config: ClientConfig;
  borrower: { address: string; account_id?: string };
  assets: { loan: Address; collateral: Address };
  policy: { max_loan_amount: string };
  dex: { router: Address; whbar: Address; wrapper: Address; code_hash: Hex };
  session: string;
  mode: "local-test-wallet";
}
export type TestWalletApproval = (tx: EvmTransaction) => Promise<boolean>;
export const serverUrl = process.env["NEXT_PUBLIC_HEDGE_SERVER"] ?? "http://127.0.0.1:3003";
export async function runtimeRequest<T>(
  path: string,
  session?: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${serverUrl}/testnet/${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(session ? { "x-hedge-session": session } : {}),
    },
    ...(body
      ? {
          body: JSON.stringify(body, (_key, value) =>
            typeof value === "bigint" ? String(value) : value,
          ),
        }
      : {}),
  });
  if (!response.ok) {
    const error = (await response
      .json()
      .catch(() => ({ message: "Hedge service is unavailable" }))) as {
      message?: string;
      error?: string;
    };
    throw new Error(error.message ?? error.error ?? "Hedge service is unavailable");
  }
  return response.json() as Promise<T>;
}
/** EVM wallets sign their own transactions. Local signing is an explicit test-only option. */
export class RuntimeWallet implements EvmWallet {
  private selected = new Map<Chain, WalletIdentity>();
  constructor(
    readonly profile: RuntimeProfile,
    private readonly reader: EvmHedgeReader,
    readonly mode: "injected" | "local",
    private readonly approve: TestWalletApproval,
  ) {}
  private provider(): EIP1193Provider {
    const provider = (window as Window & { ethereum?: EIP1193Provider }).ethereum;
    if (!provider) throw new Error("Connect an EVM wallet in your browser to continue");
    return provider;
  }
  private async network(chain: Chain) {
    const provider = this.provider(),
      chainId = `0x${this.profile.config.deployment[chain].chain_id.toString(16)}`;
    try {
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
    } catch (error) {
      if ((error as { code?: number }).code !== 4902) throw error;
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId,
            chainName: chain === "base" ? "Base Sepolia" : "Hedera Testnet",
            nativeCurrency: {
              name: chain === "base" ? "Ether" : "HBAR",
              symbol: chain === "base" ? "ETH" : "HBAR",
              decimals: 18,
            },
            rpcUrls: [this.profile.config.rpc[chain]],
            blockExplorerUrls: [
              chain === "base" ? "https://sepolia.basescan.org" : "https://hashscan.io/testnet",
            ],
          },
        ],
      });
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
    }
    if (
      Number(await provider.request({ method: "eth_chainId" })) !==
      this.profile.config.deployment[chain].chain_id
    )
      throw new Error("Wallet network did not change");
  }
  async wallet(chain: Chain): Promise<WalletIdentity | null> {
    const selected = this.selected.get(chain);
    if (!selected) return null;
    if (this.mode === "injected") {
      const accounts = await this.provider().request({ method: "eth_accounts" });
      if (!accounts.some((address) => sameAddress(address, selected.address))) {
        this.selected.delete(chain);
        return null;
      }
    }
    return selected;
  }
  async connect(chain: Chain) {
    let address = this.profile.borrower.address;
    if (this.mode === "injected") {
      const accounts = await this.provider().request({ method: "eth_requestAccounts" });
      if (!accounts[0]) throw new Error("Choose a wallet account");
      address = accounts[0];
      await this.network(chain);
    }
    const wallet = {
      chain_id: this.profile.config.deployment[chain].chain_id,
      address,
      ...(chain === "hedera"
        ? { account_id: await this.reader.config.resolveAccount(address) }
        : {}),
    };
    this.selected.set(chain, wallet);
    return wallet;
  }
  async send(tx: EvmTransaction): Promise<Hex> {
    const wallet = await this.wallet(tx.chain);
    if (!wallet) throw new Error(`Connect your ${tx.chain} wallet`);
    if (this.mode === "local") {
      if (
        !["127.0.0.1", "localhost"].includes(window.location.hostname) ||
        this.profile.mode !== "local-test-wallet"
      )
        throw new Error("Local test signing requires localhost");
      if (!(await this.approve(tx))) throw new Error("Wallet request declined");
      return (await runtimeRequest<{ hash: Hex }>("wallet", this.profile.session, tx)).hash;
    }
    await this.network(tx.chain);
    const accounts = await this.provider().request({ method: "eth_accounts" });
    if (!accounts[0] || !sameAddress(accounts[0], wallet.address))
      throw new Error("Wallet account changed before signing");
    const chain = defineChain({
      id: this.profile.config.deployment[tx.chain].chain_id,
      name: tx.chain,
      nativeCurrency: {
        name: tx.chain === "hedera" ? "HBAR" : "Ether",
        symbol: tx.chain === "hedera" ? "HBAR" : "ETH",
        decimals: 18,
      },
      rpcUrls: { default: { http: [this.profile.config.rpc[tx.chain]] } },
    });
    const client = createWalletClient({ chain, transport: custom(this.provider()) });
    return client.sendTransaction({
      account: wallet.address as Address,
      to: tx.to,
      data: tx.data,
      value: tx.value ?? 0n,
    });
  }
}
