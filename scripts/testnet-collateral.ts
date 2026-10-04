import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  create_hedge,
  createAccountResolver,
  EvmHedgeAdapter,
  EvmHedgeReader,
  tokenAbi,
  type EvmWallet,
} from "@hedge/sdk";
import { clientConfigSchema, addressSchema, accountIdSchema, hashSchema } from "@hedge/schema";
import { z } from "zod";
import { type Address, type Hex } from "viem";
import { loadEnvironment, managerConfig } from "./hedge.js";

// Explicit loopback test signer only. Public evidence contains hashes/balances, never session credentials.
loadEnvironment();
if (process.env["HEDGE_LOCAL_TESTNET"] !== "1")
  throw new Error("Enable explicit loopback testnet mode");
const local = managerConfig();
const headers: Record<string, string> = {
  origin: local.frontendUrl,
  "content-type": "application/json",
};
async function api(path: string, body?: unknown) {
  const response = await fetch(`${local.serverUrl}/testnet/${path}`, {
    method: body ? "POST" : "GET",
    headers,
    ...(body
      ? {
          body: JSON.stringify(body, (_key, value) =>
            typeof value === "bigint" ? String(value) : value,
          ),
        }
      : {}),
  });
  if (!response.ok) throw new Error(`Local testnet ${path} returned ${response.status}`);
  return response.json();
}
const profile = z
  .object({
    config: clientConfigSchema,
    borrower: z.object({ address: addressSchema, account_id: accountIdSchema }),
    session: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .parse(await api("config"));
const config = profile.config;
if (config.deployment.protocol_version !== 3)
  throw new Error("Collateral repayment requires the verified v3 pair");
headers["x-hedge-session"] = profile.session;
const reader = new EvmHedgeReader({
  manifest: config.deployment,
  rpc: config.rpc,
  startBlock: { hedera: BigInt(config.start_block.hedera), base: BigInt(config.start_block.base) },
  resolveAccount: createAccountResolver(config.mirror_url),
});
await reader.verifyDeployment();
const directory = resolve(tmpdir(), "hedge-tests", config.deployment.instance_id);
await mkdir(directory, { recursive: true, mode: 0o700 });
const path = resolve(directory, "collateral-test.json");
type Metrics = Record<"borrowerBase" | "operatorBase" | "borrowerHedera" | "capital", string>;
type State = {
  instance: string;
  id?: string;
  journal: Record<string, Hex>;
  before?: Metrics;
  funded?: Metrics;
};
let state: State;
try {
  state = JSON.parse(await readFile(path, "utf8"));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  state = { instance: config.deployment.instance_id, journal: {} };
}
if (state.instance !== config.deployment.instance_id)
  throw new Error("Saved test belongs to another deployment; retain its evidence");
const save = async () => {
  await writeFile(`${path}.tmp`, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  await rename(`${path}.tmp`, path);
};
const wallet: EvmWallet = {
  wallet: async (chain) => ({
    chain_id: config.deployment[chain].chain_id,
    address: profile.borrower.address,
    ...(chain === "hedera" ? { account_id: profile.borrower.account_id } : {}),
  }),
  connect: async () => {
    throw new Error("Generated test wallet must already be available");
  },
  send: async (tx) =>
    z
      .object({ hash: hashSchema })
      .parse(await api("wallet", { ...tx, value: String(tx.value ?? 0n) })).hash as Hex,
};
const adapter = new EvmHedgeAdapter({
  reader,
  operator: config.operator,
  wallet,
  journal: {
    get: (key) => state.journal[key],
    set: async (key, hash) => {
      state.journal[key] = hash;
      await save();
    },
    checkpoint: (checkpoint) => {
      state.id = checkpoint.credit_id;
    },
  },
  discover: async (request, base_owner) =>
    z.object({ ids: z.array(hashSchema) }).parse(await api("offers", { request, base_owner })).ids,
  relay: async (credit_id) => {
    await api("relay", { credit_id });
  },
  waitMs: 180000,
});
const client = create_hedge({ manifest: config.deployment, adapter });
const token = await reader.loanToken();
const asset = await reader.clients.base.readContract({
  address: reader.address("base"),
  abi: reader.vaultAbi,
  functionName: "collateralAsset",
});
const metrics = async (): Promise<Metrics> => {
  const balance = (chain: "hedera" | "base", asset: Address, account: string) =>
    reader.clients[chain].readContract({
      address: asset,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [account as Address],
    });
  const values = await Promise.all([
    balance("base", asset, profile.borrower.address),
    balance("base", asset, config.operator),
    balance("hedera", token, profile.borrower.address),
    reader.clients.hedera.readContract({
      address: reader.address("hedera"),
      abi: reader.lendingAbi,
      functionName: "capital",
      args: [config.operator as Address],
    }),
  ]);
  return {
    borrowerBase: String(values[0]),
    operatorBase: String(values[1]),
    borrowerHedera: String(values[2]),
    capital: String(values[3]),
  };
};
const action = process.argv[2];
try {
  if (action === "borrow") {
    if (state.id) await client.credit(state.id).resume();
    else {
      state.before = await metrics();
      await save();
      const intent = client.intent({
        funding: {
          token,
          amount: 100000n,
          recipient: { address: profile.borrower.address, account_id: profile.borrower.account_id },
        },
      });
      const [offer] = await intent.offers();
      if (!offer || offer.collateral.repayment_amount !== 102000n)
        throw new Error("Review the exact configured 0.1 USDC collateral repayment offer");
      const credit = await intent.accept({ offer_id: offer.id, reviewedOffer: offer });
      state.id = credit.id;
    }
    if (!(await client.credit(state.id!).funding())) throw new Error("Funding is not confirmed");
    // Preserve the payout baseline when resuming an already settled test.
    if (!state.funded) state.funded = await metrics();
    await save();
    console.log(`Confirmed 0.1 USDC test loan: ${state.id}`);
  } else if (action === "settle") {
    if (!state.id || !state.funded) throw new Error("Run borrow and confirm funding first");
    const loan = await reader.loan(state.id);
    if (loan.state !== 3) await client.credit(state.id).repayWithCollateral(loan.agreementHash);
    console.log(
      JSON.stringify(
        await client.credit(state.id).summary(),
        (_key, value) => (typeof value === "bigint" ? String(value) : value),
        2,
      ),
    );
  } else if (action === "verify") {
    if (!state.id || !state.before || !state.funded)
      throw new Error("Borrow and settle this saved test loan first");
    const summary = await client.credit(state.id).summary();
    const loan = await reader.loan(state.id),
      after = await metrics();
    const terms = loan.agreement.terms;
    if (summary.state !== "repaid" || summary.collateral_state !== "settled")
      throw new Error("Canonical collateral settlement is not complete");
    if (
      BigInt(after.operatorBase) - BigInt(state.funded.operatorBase) !==
        terms.collateralRepaymentAmount ||
      BigInt(after.borrowerBase) - BigInt(state.funded.borrowerBase) !==
        terms.collateralAmount - terms.collateralRepaymentAmount ||
      after.capital !== state.funded.capital ||
      after.borrowerHedera !== state.funded.borrowerHedera
    )
      throw new Error("Actual balances do not match the fixed repayment and remainder");
    const activity = await client.credit(state.id).activity();
    for (const stage of [
      "LoanFunded",
      "CollateralRepaymentRequested",
      "CollateralSettled",
      "CollateralRepaid",
    ])
      if (!activity.some((entry) => entry.stage === stage && entry.transaction?.confirmed))
        throw new Error(`Missing confirmed ${stage} receipt`);
    const evidence = {
      verified_at: new Date().toISOString(),
      scope: "Real testnet SDK borrow and repayment with collateral; browser signing not inferred",
      deployment: config.deployment,
      credit_id: state.id,
      borrower: profile.borrower.address,
      operator: config.operator,
      principal: String(terms.principal),
      repayment_base_usdc: String(terms.collateralRepaymentAmount),
      returned_base_usdc: String(terms.collateralAmount - terms.collateralRepaymentAmount),
      before: state.before,
      funded: state.funded,
      after,
      summary,
      activity,
    };
    const output = resolve(directory, "collateral-repayment.json");
    await writeFile(
      output,
      JSON.stringify(
        evidence,
        (_key, value) => (typeof value === "bigint" ? String(value) : value),
        2,
      ) + "\n",
      { mode: 0o600 },
    );
    console.log(`Confirmed exact Base split and Hedera repayment. Evidence: ${output}`);
  } else throw new Error("Use borrow, settle or verify");
} finally {
  await save();
}
