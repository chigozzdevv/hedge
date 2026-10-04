import {
  decodeEventLog,
  decodeFunctionData,
  encodeFunctionData,
  keccak256,
  encodeAbiParameters,
  type Hex,
  type Address,
} from "viem";
import { saucerRouterAbi, wrappedHbarAbi } from "@hedge/bindings";
import {
  EvmHedgeAdapter,
  sameAddress,
  tokenAbi,
  type EvmHedgeReader,
  type EvmWallet,
} from "@hedge/sdk";
import { hashSchema } from "@hedge/schema";
import type { SwapServices, SwapQuote, SwapRequest, SwapEstimateRequest } from "../swap/swap-types";
import type { RuntimeProfile } from "./wallet-service";
export function createSwapServices(
  profile: RuntimeProfile,
  reader: EvmHedgeReader,
  wallet: EvmWallet,
): SwapServices {
  const client = reader.clients.hedera;
  // Reuse the SDK's wallet/allowance/receipt checks for DEX approvals.
  const adapter = new EvmHedgeAdapter({
    reader,
    operator: profile.config.operator,
    wallet,
    journal: {
      get: (key) => {
        const hash = localStorage.getItem(
          `hedge:${profile.config.deployment.instance_id}:${profile.config.operator.toLowerCase()}:tx:${key}`,
        );
        return hash === null ? undefined : (hashSchema.parse(hash) as Hex);
      },
      set: (key, hash) =>
        localStorage.setItem(
          `hedge:${profile.config.deployment.instance_id}:${profile.config.operator.toLowerCase()}:tx:${key}`,
          hash,
        ),
    },
    discover: async () => {
      throw new Error("Open Use Hedge to request a loan");
    },
    relay: async () => {
      throw new Error("Open Use Hedge to resume a loan");
    },
  });
  const assets = [
    { id: "usdc", symbol: "USDC", decimals: 6, chain_id: 296, token: profile.assets.loan },
    { id: "hbar", symbol: "HBAR", decimals: 8, chain_id: 296 },
  ];
  const verifyDex = async () => {
    const code = await client.getCode({ address: profile.dex.router });
    if (!code || keccak256(code) !== profile.dex.code_hash)
      throw new Error("DEX router runtime differs from the configured deployment");
    const metadata = await reader.token("hedera", profile.assets.loan);
    if (metadata.decimals !== 6 || metadata.symbol !== "USDC")
      throw new Error("Swap token metadata differs");
  };
  const validateRoute = (request: SwapEstimateRequest) => {
    if (
      request.chain_id !== reader.manifest.hedera.chain_id ||
      request.sell_asset !== "usdc" ||
      request.buy_asset !== "hbar" ||
      request.sell_amount <= 0n
    )
      throw new Error("This testnet route supports USDC → HBAR");
  };
  const validate = (request: SwapRequest) => {
    validateRoute(request);
    if (request.slippage_bps !== 50) throw new Error("Unsupported swap slippage");
  };
  const readOutput = async (request: SwapEstimateRequest) => {
    validateRoute(request);
    await verifyDex();
    const amounts = await client.readContract({
      address: profile.dex.router,
      abi: saucerRouterAbi,
      functionName: "getAmountsOut",
      args: [request.sell_amount, [profile.assets.loan, profile.dex.whbar]],
    });
    if (amounts.length !== 2 || amounts[0] !== request.sell_amount || amounts[1] <= 0n)
      throw new Error("No liquidity is available for this swap");
    return amounts[1];
  };
  const data = (quote: SwapQuote) =>
    encodeFunctionData({
      abi: saucerRouterAbi,
      functionName: "swapExactTokensForETH",
      args: [
        quote.sell_amount,
        quote.minimum_received,
        [profile.assets.loan, profile.dex.whbar],
        quote.recipient.address as Address,
        BigInt(Math.floor(quote.expires_at / 1000)),
      ],
    });
  return {
    assets,
    routes: [{ sell: "usdc", buy: "hbar" }],
    loadDraft() {
      const saved = localStorage.getItem(`hedge:${profile.config.deployment.instance_id}:draft`);
      return saved ? JSON.parse(saved) : null;
    },
    saveDraft(draft) {
      localStorage.setItem(
        `hedge:${profile.config.deployment.instance_id}:draft`,
        JSON.stringify(draft),
      );
    },
    wallet: () => wallet.wallet("hedera"),
    subscribeWallet: wallet.subscribe ? (listener) => wallet.subscribe!(listener) : undefined,
    connect: () => wallet.connect("hedera"),
    async balance(asset, identity) {
      if (asset.id === "usdc")
        return client.readContract({
          address: profile.assets.loan,
          abi: tokenAbi,
          functionName: "balanceOf",
          args: [identity.address as Address],
        });
      const raw = await client.getBalance({ address: identity.address as Address });
      // Native RPC balance is weibar; reserve 1 HBAR for wallet gas.
      return raw > 10n ** 18n ? (raw - 10n ** 18n) / 10n ** 10n : 0n;
    },
    async estimate(request) {
      return {
        ...request,
        buy_amount: await readOutput(request),
        expires_at: Date.now() + 120_000,
      };
    },
    async quote(request) {
      validate(request);
      const output = await readOutput(request);
      const expires_at = Date.now() + 120_000;
      const minimum = (output * 9950n + 9999n) / 10_000n;
      const quote: SwapQuote = {
        ...request,
        id: keccak256(
          encodeAbiParameters(
            [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "address" }],
            [request.sell_amount, output, BigInt(expires_at), request.recipient.address as Address],
          ),
        ),
        buy_amount: output,
        minimum_received: minimum,
        expires_at,
        network_fee: { amount: 0n, symbol: "HBAR", decimals: 8 },
      };
      // Estimate the exact call when allowance/balance permit. Otherwise quote the chain's upper gas budget.
      // Wallet signing obtains an actual fee estimate before the user authorizes execution.
      const price = await client.getGasPrice();
      let gas = 800_000n;
      try {
        gas = await client.estimateGas({
          account: request.recipient.address as Address,
          to: profile.dex.router,
          data: data(quote),
        });
      } catch {
        /* Approval or funding is still required. */
      }
      quote.network_fee.amount = ((gas * price * 125n) / 100n + 10n ** 10n - 1n) / 10n ** 10n;
      return quote;
    },
    async execute(quote) {
      validate(quote);
      await verifyDex();
      await adapter.identity("hedera", quote.recipient.address);
      if (quote.expires_at <= Date.now()) throw new Error("Quote expired. Review a fresh quote");
      await adapter.ensureAllowance(
        "hedera",
        profile.assets.loan,
        profile.dex.router,
        quote.sell_amount,
        quote.recipient.address,
        `${quote.id}-swap`,
      );
      if (quote.expires_at <= Date.now())
        throw new Error("Quote expired during approval. Review a fresh quote");
      const tx = {
        chain: "hedera" as const,
        to: profile.dex.router,
        data: data(quote),
        key: `${quote.id}-swap`,
        label: `Swap ${Number(quote.sell_amount) / 1e6} USDC to HBAR`,
      };
      const hash = await wallet.send(tx);
      // Public checkpoint only; recover this transaction instead of sending the swap again.
      localStorage.setItem(
        `hedge:${profile.config.deployment.instance_id}:swap`,
        JSON.stringify({ hash, quote }, (_key, value) =>
          typeof value === "bigint" ? String(value) : value,
        ),
      );
      return hash;
    },
    async receipt(transactionId, quote) {
      const hash = transactionId as Hex,
        receipt = await reader.confirmed("hedera", hash);
      const tx = await client.getTransaction({ hash });
      if (
        !tx.to ||
        !sameAddress(tx.to, profile.dex.router) ||
        !sameAddress(tx.from, quote.recipient.address) ||
        tx.input !== data(quote) ||
        tx.value !== 0n
      )
        throw new Error("Swap transaction differs from the reviewed quote");
      const decoded = decodeFunctionData({ abi: saucerRouterAbi, data: tx.input });
      if (decoded.functionName !== "swapExactTokensForETH") throw new Error("Wrong swap operation");
      let received = 0n,
        spent = 0n;
      for (const log of receipt.logs) {
        if (sameAddress(log.address, profile.dex.wrapper)) {
          try {
            const event = decodeEventLog({
              abi: wrappedHbarAbi,
              data: log.data,
              topics: log.topics,
            });
            if (
              sameAddress(event.args.src, profile.dex.router) &&
              sameAddress(event.args.dst, quote.recipient.address)
            )
              received += event.args.wad;
          } catch {
            /* Unrelated wrapper event. */
          }
        }
        if (sameAddress(log.address, profile.assets.loan)) {
          try {
            const event = decodeEventLog({ abi: tokenAbi, data: log.data, topics: log.topics });
            if (
              event.eventName === "Transfer" &&
              sameAddress(event.args.from, quote.recipient.address)
            )
              spent += event.args.value;
          } catch {
            /* Unrelated token event. */
          }
        }
      }
      if (spent !== quote.sell_amount || received < quote.minimum_received)
        throw new Error("Swap transfer evidence does not match the reviewed amounts");
      return {
        transaction_id: transactionId,
        confirmed: true,
        request: quote,
        buy_amount: received,
      };
    },
    async restore() {
      const saved = localStorage.getItem(`hedge:${profile.config.deployment.instance_id}:swap`);
      if (!saved) return null;
      const value = JSON.parse(saved) as { hash: string; quote: SwapQuote };
      const q = value.quote;
      const quote = {
        ...q,
        sell_amount: BigInt(q.sell_amount),
        buy_amount: BigInt(q.buy_amount),
        minimum_received: BigInt(q.minimum_received),
        network_fee: { ...q.network_fee, amount: BigInt(q.network_fee.amount) },
      };
      validate(quote);
      if (!/^0x[\da-f]{64}$/i.test(value.hash)) throw new Error("Saved swap hash is invalid");
      return { transactionId: value.hash, quote };
    },
    clearCheckpoint() {
      localStorage.removeItem(`hedge:${profile.config.deployment.instance_id}:swap`);
    },
  };
}
