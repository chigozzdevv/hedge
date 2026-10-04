import { randomBytes } from "node:crypto";
import {
  decodeEventLog,
  decodeFunctionData,
  encodeFunctionData,
  encodeAbiParameters,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { saucerRouterAbi } from "@hedge/bindings";
import {
  EvmHedgeReader,
  createAccountResolver,
  sameAddress,
  tokenAbi,
  type EvmTransaction,
  type EvmTerms,
} from "@hedge/sdk";
import { addressSchema, type LoanRequest } from "@hedge/schema";
import { createCcipRelay } from "../credit/ccip-relay.js";
import { createLegacyRelay } from "../credit/legacy-relay.js";
import { LocalTestSigner } from "../../shared/chain/local-signer.js";
import { compileQuotePolicy, loadOperatorPolicy, type OperatorPolicy } from "./quote-policy.js";
import { loadPublicConfig } from "../../shared/config/hedge-config.js";
import { readWallets } from "../../shared/config/wallets.js";

const loanToken = "0x0000000000000000000000000000000000001549" as Address;
const collateral = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address;
const router = "0x0000000000000000000000000000000000004b40" as Address;
const whbar = "0x0000000000000000000000000000000000003ad2" as Address;
const wrapper = "0x0000000000000000000000000000000000003ad1" as Address;

/** Offers bind each borrower's wallets; local test signing remains limited to its own wallets. */
export async function createTestnetService(root: string, configuredPolicy?: OperatorPolicy) {
  const policyConfig = configuredPolicy ?? (await loadOperatorPolicy(root));
  const config = loadPublicConfig(root);
  {
    const operatorUrl = new URL(config.operator_url);
    if (
      operatorUrl.protocol !== "http:" ||
      operatorUrl.hostname !== "127.0.0.1" ||
      !operatorUrl.port ||
      operatorUrl.pathname !== "/testnet" ||
      operatorUrl.search ||
      operatorUrl.hash
    )
      throw new Error("Local testnet operator requires an explicit loopback /testnet URL");
  }
  const manifest = config.deployment;
  const operator = config.operator as Address;
  if (manifest.hedera.chain_id !== 296 || manifest.base.chain_id !== 84532)
    throw new Error("Testnet chains required");
  const wallets = readWallets(root);
  if (!sameAddress(wallets.hedera.address, operator))
    throw new Error("Local operator signer does not match operator in hedge.config.json");
  const borrower = wallets.base.address;
  if (
    policyConfig.loan_asset.chain_id !== manifest.hedera.chain_id ||
    policyConfig.accepted_collateral.chain_id !== manifest.base.chain_id ||
    !sameAddress(policyConfig.loan_asset.address, loanToken) ||
    !sameAddress(policyConfig.accepted_collateral.address, collateral)
  )
    throw new Error("Configured assets must match the supported USDC deployment pair");
  const policy = compileQuotePolicy(policyConfig);
  const resolveAccount = createAccountResolver(config.mirror_url);
  const reader = new EvmHedgeReader({
    manifest,
    rpc: config.rpc,
    startBlock: {
      hedera: BigInt(config.start_block.hedera),
      base: BigInt(config.start_block.base),
    },
    resolveAccount,
  });
  await reader.verifyDeployment();
  if (!sameAddress(await reader.loanToken(), loanToken))
    throw new Error("Testnet loan token differs");
  if (
    !sameAddress(
      await reader.clients.hedera.readContract({
        address: reader.address("hedera"),
        abi: reader.lendingAbi,
        functionName: "collateralAsset",
      }),
      policyConfig.accepted_collateral.address,
    )
  )
    throw new Error("Configured collateral differs from the deployed asset");
  const signer = new LocalTestSigner(root, reader);
  const session = randomBytes(32).toString("hex");
  const dexCode = await reader.clients.hedera.getCode({ address: router });
  if (!dexCode) throw new Error("DEX router is not deployed");
  const profile = {
    config,
    borrower: {
      address: borrower,
      account_id: await resolveAccount(borrower).catch(() => undefined),
    },
    assets: { loan: loanToken, collateral },
    policy: { max_loan_amount: policyConfig.max_loan_amount },
    dex: { router, whbar, wrapper, code_hash: keccak256(dexCode) },
    session,
    mode: "local-test-wallet",
  };
  let offersTail: Promise<unknown> = Promise.resolve();
  const discovery = async (request: LoanRequest, baseOwner: string): Promise<Hex[]> => {
    const recipient = request.funding.recipient.address as Address;
    const owner = addressSchema.parse(baseOwner) as Address;
    if (
      /^0x0{40}$/i.test(owner) ||
      !sameAddress(request.funding.token, loanToken) ||
      !policy.eligible(recipient) ||
      request.funding.amount > policy.maxPrincipal ||
      request.funding.amount <= 0n
    )
      throw new Error("Borrower or amount is outside the configured operator policy");
    if (request.funding.recipient.account_id !== (await resolveAccount(recipient)))
      throw new Error("Borrower account does not match its Hedera wallet");
    const matches: Hex[] = [],
      open: Hex[] = [];
    const now = (await reader.clients.hedera.getBlock()).timestamp;
    for (const log of await reader.logs("hedera")) {
      let id: Hex;
      try {
        const event = decodeEventLog({
          abi: reader.lendingAbi,
          data: log.data,
          topics: log.topics,
        });
        if (event.eventName !== "OfferPublished") continue;
        id = event.args.offerId;
      } catch {
        continue;
      }
      const raw = await reader.clients.hedera.readContract({
        address: reader.address("hedera"),
        abi: reader.lendingAbi,
        functionName: "getOffer",
        args: [id],
      });
      if (raw.state !== 1) continue;
      if (
        !sameAddress(raw.operator, operator) ||
        !sameAddress(raw.terms.borrower, recipient) ||
        !sameAddress(raw.terms.collateralOwner, owner)
      )
        continue;
      open.push(id);
      if (
        raw.terms.acceptanceDeadline > now &&
        raw.terms.principal === request.funding.amount &&
        policy.matches(raw.terms) &&
        sameAddress(raw.terms.fundingRecipient, recipient) &&
        sameAddress(raw.terms.returnRecipient, owner)
      )
        matches.push(id);
    }
    if (matches.length) return matches;
    // Replace only this wallet pair's unused offers; other borrowers retain their quotes.
    for (const id of open) {
      const withdrawn = await signer.send(
        {
          chain: "hedera",
          to: reader.address("hedera"),
          data: encodeFunctionData({
            abi: reader.lendingAbi,
            functionName: "withdrawOffer",
            args: [id],
          }),
          key: `${manifest.instance_id}:${id}:withdraw`,
          label: "Withdraw unused test offer",
        },
        false,
      );
      await reader.confirmed("hedera", withdrawn);
    }
    const nonce = await reader.clients.hedera.readContract({
      address: reader.address("hedera"),
      abi: reader.lendingAbi,
      functionName: "offerNonce",
      args: [operator],
    });
    const id = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }],
        [manifest.instance_id as Hex, operator, nonce + 1n],
      ),
    );
    const terms: EvmTerms = {
      borrower: recipient,
      fundingRecipient: recipient,
      ...policy.quote(request.funding.amount),
      ...(manifest.protocol_version === 2 ? { collateralRepaymentAmount: 0n } : {}),
      collateralAsset: collateral,
      collateralOwner: owner,
      returnRecipient: owner,
      recoveryRecipient: operator,
      acceptanceDeadline: now + 1800n,
      setupDeadline: now + 3600n,
    };
    const published = await signer.send(
      {
        chain: "hedera",
        to: reader.address("hedera"),
        data: encodeFunctionData({
          abi: reader.lendingAbi,
          functionName: "publishOffer",
          args: [terms],
        }),
        key: `${manifest.instance_id}:${id}:publish`,
        label: "Publish funded testnet offer",
      },
      false,
    );
    await reader.confirmed("hedera", published);
    const actual = await reader.offer(id);
    if (actual.funding.amount !== request.funding.amount)
      throw new Error("Published offer differs from request");
    return [id];
  };
  const discover = (request: LoanRequest, baseOwner: string) => {
    const job = offersTail.catch(() => undefined).then(() => discovery(request, baseOwner));
    offersTail = job;
    return job;
  };
  const currentRelay = createCcipRelay(reader, signer);
  const legacy = await createLegacyRelay(root, config, signer);
  const relay = async (id: string) => {
    try {
      await reader.loan(id);
    } catch (error) {
      if (
        legacy &&
        error instanceof Error &&
        "code" in error &&
        error.code === "CREDIT_UNAVAILABLE"
      ) {
        await legacy.reader.loan(id);
        await legacy.relay(id);
        return;
      }
      throw error;
    }
    await currentRelay(id);
  };
  const amountAllowed = async (
    tx: EvmTransaction,
    amount: bigint,
    kind: "collateral" | "repayment" | "principal",
  ) => {
    const current =
      kind === "collateral"
        ? policy.maxCollateral
        : kind === "repayment"
          ? policy.maxRepayment
          : policy.maxPrincipal;
    if (amount <= current) return true;
    // A reduced policy cannot block the collateral/repayment obligations of an accepted loan.
    const match = tx.key.startsWith(`${manifest.instance_id}:${tx.chain}:`)
      ? /:(0x[\da-fA-F]{64})-(collateral|repayment)-(approve|reset)$/.exec(tx.key)
      : null;
    const ids =
      kind === "principal"
        ? await reader.outstandingLoans(borrower)
        : match?.[2] === kind
          ? [match[1]]
          : [];
    for (const id of ids) {
      const loan = await reader.loan(id);
      const terms = loan.agreement.terms;
      if (
        !sameAddress(terms.borrower, borrower) ||
        !sameAddress(terms.collateralOwner, borrower) ||
        !sameAddress(terms.returnRecipient, borrower)
      )
        continue;
      const agreed =
        kind === "collateral" && loan.state === 1
          ? terms.collateralAmount
          : kind === "repayment" && loan.state === 2
            ? terms.repaymentAmount
            : kind === "principal" && loan.state === 2
              ? terms.principal
              : 0n;
      if (amount <= agreed) return true;
    }
    return false;
  };
  const validateBorrower = async (tx: EvmTransaction) => {
    if ((tx.value ?? 0n) !== 0n)
      throw new Error("Native-value signing is disabled for this token-to-HBAR test route");
    if (tx.chain === "hedera" && sameAddress(tx.to, reader.address("hedera"))) {
      const call = decodeFunctionData({ abi: reader.lendingAbi, data: tx.data });
      if (call.functionName === "accept") {
        const raw = await reader.clients.hedera.readContract({
          address: tx.to,
          abi: reader.lendingAbi,
          functionName: "getOffer",
          args: [call.args[0]],
        });
        if (
          !sameAddress(raw.operator, operator) ||
          !sameAddress(raw.terms.borrower, borrower) ||
          !sameAddress(raw.terms.collateralOwner, borrower) ||
          (raw.state !== 1 && raw.state !== 2) ||
          (raw.state !== 2 && (!policy.eligible(borrower) || !policy.matches(raw.terms))) ||
          raw.termsHash !== call.args[1]
        )
          throw new Error("Unapproved test offer");
        return;
      }
      if (
        call.functionName === "repay" ||
        call.functionName === "cancel" ||
        call.functionName === "repayWithCollateral"
      ) {
        const loan = await reader.loan(call.args[0]);
        if (
          !sameAddress(loan.agreement.terms.borrower, borrower) ||
          (call.functionName === "repay" &&
            call.args[1] !== loan.agreement.terms.repaymentAmount) ||
          (call.functionName === "repayWithCollateral" && call.args[1] !== loan.agreementHash)
        )
          throw new Error("Unapproved loan operation");
        return;
      }
      throw new Error("Operator actions are not borrower wallet operations");
    }
    if (tx.chain === "base" && sameAddress(tx.to, reader.address("base"))) {
      const call = decodeFunctionData({ abi: reader.vaultAbi, data: tx.data });
      if (
        call.functionName !== "lock" &&
        call.functionName !== "claim" &&
        call.functionName !== "settle"
      )
        throw new Error("Unapproved Base operation");
      const loan = await reader.loan(call.args[0]);
      if (
        !sameAddress(loan.agreement.terms.collateralOwner, borrower) ||
        !sameAddress(loan.agreement.terms.returnRecipient, borrower) ||
        (call.functionName === "lock" && call.args[1] !== loan.agreementHash)
      )
        throw new Error("Collateral binding differs");
      return;
    }
    if (sameAddress(tx.to, tx.chain === "hedera" ? loanToken : collateral)) {
      const call = decodeFunctionData({ abi: tokenAbi, data: tx.data });
      if (call.functionName === "associate" && tx.chain === "hedera") return;
      if (call.functionName === "approve") {
        const [spender, amount] = call.args;
        const protocol = sameAddress(spender, reader.address(tx.chain));
        const dex = tx.chain === "hedera" && sameAddress(spender, router);
        const kind = tx.chain === "base" ? "collateral" : protocol ? "repayment" : "principal";
        if ((protocol || dex) && (await amountAllowed(tx, amount, kind))) return;
      }
      throw new Error("Token approval target or amount exceeds local test policy");
    }
    if (tx.chain === "hedera" && sameAddress(tx.to, router)) {
      const call = decodeFunctionData({ abi: saucerRouterAbi, data: tx.data });
      if (call.functionName !== "swapExactTokensForETH")
        throw new Error("Only the verified USDC to HBAR route is enabled");
      const [amount, minimum, path, to, deadline] = call.args;
      const timestamp = (await reader.clients.hedera.getBlock()).timestamp;
      if (
        amount <= 0n ||
        minimum <= 0n ||
        path.length !== 2 ||
        !sameAddress(path[0], loanToken) ||
        !sameAddress(path[1], whbar) ||
        !sameAddress(to, borrower) ||
        deadline <= timestamp ||
        deadline > timestamp + 300n
      )
        throw new Error("Swap parameters exceed local test policy");
      if (!(await amountAllowed(tx, amount, "principal")))
        throw new Error("Swap amount exceeds local test policy");
      const quote = await reader.clients.hedera.readContract({
        address: router,
        abi: saucerRouterAbi,
        functionName: "getAmountsOut",
        args: [amount, [loanToken, whbar]],
      });
      if (minimum < (quote[1] * 99n) / 100n)
        throw new Error("Swap minimum permits excessive slippage");
      return;
    }
    throw new Error("Transaction target is outside the local test policy");
  };
  const loans = () => reader.outstandingLoans(borrower);
  return {
    reader,
    profile,
    session,
    legacy,
    discover,
    relay,
    borrower,
    loans,
    async send(tx: EvmTransaction) {
      await validateBorrower(tx);
      return signer.send({ ...tx, key: `${manifest.instance_id}:borrower:${tx.key}` }, true);
    },
  };
}
export type TestnetService = Awaited<ReturnType<typeof createTestnetService>>;
