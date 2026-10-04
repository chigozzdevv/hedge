import { randomUUID } from "node:crypto";
import { decodeFunctionData, encodeFunctionData, formatEther, formatUnits, type Hex } from "viem";
import { hedgeLendingAbi } from "@hedge/bindings";
import {
  create_hedge,
  EvmHedgeAdapter,
  HedgeError,
  parseAmount,
  sameAddress,
  tokenAbi,
  type EvmHedgeReader,
  type EvmTransaction,
} from "@hedge/sdk";
import { OperatorWallet } from "./operator-wallet.js";
import { databaseStore } from "./liquidity-store.js";
import type {
  LiquidityJournal as Journal,
  LiquidityStore,
} from "../server/src/features/operator/liquidity.schema.js";

export type LiquidityRequest =
  | { action: "status" }
  | { action: "deposit" | "withdraw"; amount: string };

export function liquidityRequest(args: string[]): LiquidityRequest {
  const [action = "status", amount, ...extra] = args;
  if (action === "status" && amount === undefined) return { action };
  if (!["deposit", "withdraw"].includes(action) || amount === undefined || extra.length)
    throw new Error("Use liquidity [status|deposit AMOUNT|withdraw AMOUNT]");
  if (amount.length > 100 || !/^\d+(?:\.\d*)?$/.test(amount) || !/[1-9]/.test(amount))
    throw new Error("Enter a positive token amount; scientific notation is not supported");
  return { action: action as "deposit" | "withdraw", amount };
}

/** Only the selected instance's approval and exact requested capital change can be signed. */
export function validateLiquidityCall(
  tx: Pick<EvmTransaction, "chain" | "to" | "data" | "value">,
  journal: Pick<Journal, "token" | "action" | "amount">,
  lending: string,
): void {
  if (tx.chain !== "hedera" || (tx.value ?? 0n) !== 0n)
    throw new Error("Liquidity cannot send native value or use another chain");
  const amount = BigInt(journal.amount);
  if (sameAddress(tx.to, journal.token) && journal.action === "deposit") {
    const decoded = decodeFunctionData({ abi: tokenAbi, data: tx.data });
    if (
      decoded.functionName === "approve" &&
      sameAddress(decoded.args[0], lending) &&
      (decoded.args[1] === 0n || decoded.args[1] === amount)
    )
      return;
  } else if (sameAddress(tx.to, lending)) {
    const expected = encodeFunctionData({
      abi: hedgeLendingAbi,
      functionName: journal.action,
      args: [amount],
    });
    if (tx.data === expected) return;
  }
  throw new Error("Transaction differs from the requested liquidity operation");
}

export async function runLiquidity(
  root: string,
  reader: EvmHedgeReader,
  operatorAddress: string,
  request: LiquidityRequest,
  checkInterrupted: () => void = () => undefined,
  suppliedStore?: LiquidityStore,
): Promise<void> {
  const token = await reader.token("hedera", await reader.loanToken());
  const chain = reader.clients.hedera;
  const readOnly = new EvmHedgeAdapter({
    reader,
    operator: operatorAddress,
    wallet: {
      wallet: async () => null,
      connect: async () => {
        throw new Error("Read-only liquidity request");
      },
      send: async () => {
        throw new Error("Read-only liquidity request");
      },
    },
    journal: { get: () => undefined, set: () => undefined },
    discover: async () => {
      throw new Error("Liquidity does not publish offers");
    },
    relay: async () => {
      throw new Error("Liquidity does not relay loans");
    },
  });
  const show = async () => {
    const [summary, gas] = await Promise.all([
      readOnly.operatorSummary(operatorAddress),
      chain.getBalance({ address: operatorAddress as Hex }),
    ]);
    console.log(`Operator: ${operatorAddress}`);
    console.log(`Loan token: ${token.symbol} (${token.address})`);
    console.log(`Available: ${formatUnits(summary.free_capital, token.decimals)} ${token.symbol}`);
    console.log(
      `Reserved: ${formatUnits(summary.reserved_capital, token.decimals)} ${token.symbol}`,
    );
    console.log(`Gas balance: ${formatEther(gas)} HBAR`);
  };
  if (request.action === "status") {
    await show();
    return;
  }
  const amount = parseAmount(request.amount, token.decimals);
  const maxFee = parseAmount(process.env["HEDGE_OPERATOR_MAX_FEE_HBAR"] || "2", 18);
  const minimum = process.env["HEDGE_OPERATOR_MIN_HBAR"] || "5";
  const reserve = minimum === "0" ? 0n : parseAmount(minimum, 18);
  const database = suppliedStore
    ? undefined
    : await databaseStore(root, reader.manifest.instance_id, operatorAddress);
  const store = suppliedStore ?? database!.store;
  try {
    let journal = await store.read();
    if (
      journal &&
      !matches(journal, reader, operatorAddress, token.address, request.action, amount)
    )
      throw new Error("A liquidity operation is pending; rerun its original command to resume it");
    if (!journal) {
      if (request.action === "withdraw") {
        const summary = await readOnly.operatorSummary(operatorAddress);
        if (amount > summary.free_capital)
          throw new Error("Withdrawal exceeds your available capital");
      } else {
        const balance = await chain.readContract({
          address: token.address as Hex,
          abi: tokenAbi,
          functionName: "balanceOf",
          args: [operatorAddress as Hex],
        });
        if (amount > balance)
          throw new Error(`Top up the operator wallet with ${token.symbol} first`);
      }
      journal = {
        version: 1,
        id: randomUUID(),
        instance: reader.manifest.instance_id,
        operator: operatorAddress,
        token: token.address,
        action: request.action,
        amount: String(amount),
        status: "pending",
        calls: [],
        hashes: {},
      };
    }
    const saved = journal;
    const save = () => store.save(saved);
    const validate = (tx: EvmTransaction) =>
      validateLiquidityCall(tx, saved, reader.address("hedera"));
    const wallet = new OperatorWallet(
      root,
      reader,
      operatorAddress,
      saved.calls,
      save,
      validate,
      maxFee,
      reserve,
      checkInterrupted,
      () => store.assertOwned(),
    );
    const finalData = encodeFunctionData({
      abi: hedgeLendingAbi,
      functionName: saved.action,
      args: [amount],
    });
    let confirmed: Hex | undefined;
    try {
      for (const call of saved.calls) {
        checkInterrupted();
        validate({ chain: "hedera", ...call, key: saved.id, label: "Resume liquidity" });
        await wallet.broadcast(call);
        await reader.confirmed("hedera", call.hash);
        if (sameAddress(call.to, reader.address("hedera")) && call.data === finalData)
          confirmed = call.hash;
      }
      if (saved.status === "complete" && !confirmed)
        throw new Error("Completed liquidity journal has no confirmed capital transaction");
      if (!confirmed) {
        checkInterrupted();
        const adapter = new EvmHedgeAdapter({
          ...readOnly.options,
          wallet,
          journal: {
            get: (key) => saved.hashes[key],
            set: async (key, hash) => {
              saved.hashes[key] = hash;
              await save();
            },
          },
        });
        const operator = create_hedge({ manifest: reader.manifest, adapter }).operator(
          operatorAddress,
        );
        const result = await operator[saved.action]({ token: token.address, amount });
        confirmed = result.hash as Hex;
      }
      await store.complete(saved);
    } catch (error) {
      if (error instanceof HedgeError && error.code === "TRANSACTION_REVERTED")
        await store.complete(saved, "failed");
      throw error;
    }
    console.log(
      `Confirmed ${saved.action}: ${formatUnits(amount, token.decimals)} ${token.symbol}`,
    );
    console.log(`Transaction: ${confirmed}`);
    await show();
  } finally {
    await database?.close();
  }
}

function matches(
  journal: Journal,
  reader: EvmHedgeReader,
  operator: string,
  token: string,
  action: string,
  amount: bigint,
) {
  return (
    journal.instance === reader.manifest.instance_id &&
    sameAddress(journal.operator, operator) &&
    sameAddress(journal.token, token) &&
    journal.action === action &&
    BigInt(journal.amount) === amount
  );
}
