/** Read-only receipt reconciliation for the real browser test. No signer or keys are imported. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { decodeEventLog, decodeFunctionData, keccak256, type Hex } from "viem";
import { EvmHedgeReader, tokenAbi, createAccountResolver } from "@hedge/sdk";
import { hedgeLendingAbi, hedgeVaultAbi, saucerRouterAbi, wrappedHbarAbi } from "@hedge/bindings";
import { deploymentConfigSchema } from "@hedge/schema";

const root = process.cwd();
const ids = process.argv.slice(2);
if (!ids.length || ids.some((id) => !/^0x[\da-fA-F]{64}$/.test(id)))
  throw new Error("Supply the exact browser-tested loan IDs");
const config = deploymentConfigSchema.parse(
  JSON.parse(await readFile(resolve(root, "deployments/testnet.json"), "utf8")),
);
const reader = new EvmHedgeReader({
  manifest: config.deployment,
  rpc: config.rpc,
  startBlock: { hedera: BigInt(config.start_block.hedera), base: BigInt(config.start_block.base) },
  resolveAccount: createAccountResolver(config.mirror_url),
});
await reader.verifyDeployment();
const events = { hedera: await reader.logs("hedera"), base: await reader.logs("base") };
const loans = [];
for (const id of ids) {
  const loan = await reader.loan(id),
    summary = await reader.summary(id),
    agreement = await reader.agreement(id);
  if (summary.state !== "repaid" || summary.collateral_state !== "returned")
    throw new Error(`Loan ${id} has not completed repayment and return`);
  const operations: Record<string, { hash: Hex; timestamp: number; receipt: unknown }> = {};
  for (const chain of ["hedera", "base"] as const)
    for (const log of events[chain]) {
      try {
        const event = decodeEventLog({
          abi: chain === "hedera" ? hedgeLendingAbi : hedgeVaultAbi,
          data: log.data,
          topics: log.topics,
        });
        if (!("loanId" in event.args) || event.args.loanId !== id || !log.transactionHash) continue;
        const receipt = await reader.confirmed(chain, log.transactionHash);
        if (receipt.blockHash !== log.blockHash) throw new Error("Event receipt block differs");
        const block = await reader.clients[chain].getBlock({ blockNumber: receipt.blockNumber });
        operations[event.eventName] = {
          hash: log.transactionHash,
          timestamp: Number(block.timestamp),
          receipt,
        };
      } catch (error) {
        if (error instanceof Error && /differs|revert|pending/.test(error.message)) throw error;
      }
    }
  if (
    !operations["LoanAccepted"] ||
    !operations["LoanFunded"] ||
    !operations["LoanFinalized"] ||
    !operations["CollateralLocked"] ||
    !operations["CollateralClaimed"]
  )
    throw new Error("Lifecycle receipts are missing");
  const messages = [];
  for (const kind of [0, 1, 2]) {
    const box = await reader.outbox(id, kind);
    if (!box.delivered || box.submissions !== 1n)
      throw new Error(
        "Every lifecycle message must have exactly one successful submission and a matching receiver marker",
      );
    const destination = kind === 1 ? "hedera" : "base",
      source = kind === 1 ? "base" : "hedera";
    const find = (chain: "hedera" | "base", name: "MessageSubmitted" | "MessageReceived") =>
      events[chain].find((log) => {
        try {
          const event = decodeEventLog({
            abi: hedgeLendingAbi,
            data: log.data,
            topics: log.topics,
          });
          return event.eventName === name && event.args.messageId === box.lastMessageId;
        } catch {
          return false;
        }
      });
    const sent = find(source, "MessageSubmitted"),
      received = find(destination, "MessageReceived");
    if (!sent?.transactionHash || !received?.transactionHash)
      throw new Error("Exact CCIP source or destination receipt missing");
    const sourceReceipt = await reader.confirmed(source, sent.transactionHash),
      destinationReceipt = await reader.confirmed(destination, received.transactionHash);
    const [sourceBlock, destinationBlock] = await Promise.all([
      reader.clients[source].getBlock({ blockNumber: sourceReceipt.blockNumber }),
      reader.clients[destination].getBlock({ blockNumber: destinationReceipt.blockNumber }),
    ]);
    messages.push({
      kind: ["agreement", "custody", "outcome"][kind],
      messageId: box.lastMessageId,
      payloadHash: keccak256(box.payload),
      sourceHash: sent.transactionHash,
      destinationHash: received.transactionHash,
      sourceReceipt,
      destinationReceipt,
      deliverySeconds: Number(destinationBlock.timestamp - sourceBlock.timestamp),
      explorer: `https://ccip.chain.link/msg/${box.lastMessageId}`,
    });
  }
  loans.push({
    id,
    agreement,
    summary,
    fundedAt: loan.fundedAt,
    paymentDeadline: loan.paymentDeadline,
    operations,
    messages,
    timingsSeconds: {
      acceptanceToPayout: operations["LoanFunded"].timestamp - operations["LoanAccepted"].timestamp,
      lockToPayout: operations["LoanFunded"].timestamp - operations["CollateralLocked"].timestamp,
      acceptanceToCollateralReturn:
        operations["CollateralClaimed"].timestamp - operations["LoanAccepted"].timestamp,
    },
  });
}
const swaps = [];
const swapHashes = (process.env["HEDGE_SWAP_HASHES"] ?? "").split(",").filter(Boolean);
for (const transactionHash of swapHashes) {
  if (!/^0x[\da-fA-F]{64}$/.test(transactionHash)) throw new Error("Invalid swap receipt hash");
  const transaction = await reader.clients.hedera.getTransaction({ hash: transactionHash as Hex });
  if (!transaction.to) continue;
  const record = {
    transactionHash: transactionHash as Hex,
    transaction: { to: transaction.to, data: transaction.input, value: transaction.value },
  };
  if (record.transaction.to.toLowerCase() !== "0x0000000000000000000000000000000000004b40")
    continue;
  const call = decodeFunctionData({ abi: saucerRouterAbi, data: record.transaction.data });
  if (call.functionName !== "swapExactTokensForETH") continue;
  const receipt = await reader.confirmed("hedera", record.transactionHash);
  const output = receipt.logs.flatMap((log) => {
    if (log.address.toLowerCase() !== "0x0000000000000000000000000000000000003ad1") return [];
    try {
      return [decodeEventLog({ abi: wrappedHbarAbi, data: log.data, topics: log.topics }).args];
    } catch {
      return [];
    }
  });
  if (
    output.length !== 1 ||
    output[0].src.toLowerCase() !== record.transaction.to.toLowerCase() ||
    output[0].wad < call.args[1] ||
    output[0].dst.toLowerCase() !== call.args[3].toLowerCase()
  )
    throw new Error("Actual swap output does not match the reviewed recipient/minimum");
  swaps.push({
    hash: record.transactionHash,
    inputRaw: call.args[0],
    minimumOutputTinybar: call.args[1],
    actualOutputTinybar: output[0].wad,
    recipient: call.args[3],
    receipt,
  });
}
if (!swaps.length) throw new Error("A separately confirmed browser swap is required");
const [capital, reservedCapital, collateralBalance] = await Promise.all([
  reader.clients.hedera.readContract({
    address: reader.address("hedera"),
    abi: hedgeLendingAbi,
    functionName: "capital",
    args: [config.operator as `0x${string}`],
  }),
  reader.clients.hedera.readContract({
    address: reader.address("hedera"),
    abi: hedgeLendingAbi,
    functionName: "reservedCapital",
    args: [config.operator as `0x${string}`],
  }),
  reader.clients.base.readContract({
    address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    abi: tokenAbi,
    functionName: "balanceOf",
    args: [reader.address("base")],
  }),
]);
if (reservedCapital !== 0n || collateralBalance !== 0n)
  throw new Error("The recorded browser run still has reserved capital or locked collateral");
const output = {
  schemaVersion: 1,
  scope: "browser happy path with local test wallets",
  testAssetsOnly: true,
  verifiedAt: new Date().toISOString(),
  deploymentManifest: "deployments/testnet.json",
  liveFrontendIntegrated: true,
  browserWalletExtensionLiveVerified: false,
  liveDefaultCancellationRecoveryVerified: false,
  loans,
  swaps,
  externalBuffers: [],
  finalBalances: {
    capitalRaw: capital,
    reservedCapitalRaw: reservedCapital,
    vaultCollateralRaw: collateralBalance,
  },
};
const evidenceDirectory = resolve(tmpdir(), "hedge-tests", config.deployment.instance_id);
await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
await writeFile(
  resolve(evidenceDirectory, "browser.json"),
  JSON.stringify(output, (_key, value) => (typeof value === "bigint" ? String(value) : value), 2) +
    "\n",
);
console.log(
  JSON.stringify({
    file: resolve(evidenceDirectory, "browser.json"),
    loans: loans.map((loan) => ({ id: loan.id, timings: loan.timingsSeconds })),
    swaps: swaps.map((swap) => swap.hash),
  }),
);
