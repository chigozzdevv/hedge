import {
  createPublicClient,
  http,
  encodeAbiParameters,
  getAbiItem,
  decodeEventLog,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
  type ReadContractReturnType,
  type PublicClient,
} from "viem";
import {
  hedgeLendingAbi,
  hedgeVaultAbi,
  hedgeLendingV2Abi,
  hedgeVaultV2Abi,
} from "@hedge/bindings";
import {
  deploymentSchema,
  type DeploymentManifest,
  type Offer,
  type CreditSummary,
  type Chain,
  type TokenMetadata,
} from "@hedge/schema";
import { HedgeError } from "../client/hedge-error";
import { sameAddress } from "./address";

export type EvmLoan = ReadContractReturnType<typeof hedgeLendingAbi, "getLoan">;
export type EvmTerms = EvmLoan["agreement"]["terms"];
export const tokenAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function isAssociated() view returns (bool)",
  "function associate() returns (int64)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
const zero = `0x${"0".repeat(64)}`;
export function loanId(instance: Hex, offer: Hex, version = 3): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "bytes32" }, { type: "bytes32" }],
      [`hedge-loan-v${version}`, instance, offer],
    ),
  );
}
export function agreementHash(agreement: EvmLoan["agreement"]): Hex {
  const parameter = getAbiItem({
    abi: (agreement.version === 2 ? hedgeLendingV2Abi : hedgeLendingAbi) as typeof hedgeLendingAbi,
    name: "getLoan",
  }).outputs[0].components[0];
  return keccak256(encodeAbiParameters([parameter], [agreement]));
}
export function termsHash(
  instance: Hex,
  id: Hex,
  token: Address,
  terms: EvmTerms,
  operator: Address,
  version = 3,
): Hex {
  const parameter = getAbiItem({
    abi: (version === 2 ? hedgeLendingV2Abi : hedgeLendingAbi) as typeof hedgeLendingAbi,
    name: "publishOffer",
  }).inputs[0];
  return keccak256(
    encodeAbiParameters(
      [
        { type: "uint16" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "address" },
        { type: "address" },
        parameter,
      ],
      [version, instance, id, operator, token, terms],
    ),
  );
}
export interface EvmReaderConfig {
  manifest: DeploymentManifest;
  rpc: Record<Chain, string>;
  /** Deployment blocks, used only for discovery. Every result is verified against current contracts. */
  startBlock: Record<Chain, bigint>;
  resolveAccount(address: string): Promise<string>;
}
export class EvmHedgeReader {
  get lendingAbi(): typeof hedgeLendingAbi {
    return (
      this.manifest.protocol_version === 2 ? hedgeLendingV2Abi : hedgeLendingAbi
    ) as typeof hedgeLendingAbi;
  }
  get vaultAbi(): typeof hedgeVaultAbi {
    return (
      this.manifest.protocol_version === 2 ? hedgeVaultV2Abi : hedgeVaultAbi
    ) as typeof hedgeVaultAbi;
  }
  private normalizeTerms(terms: EvmTerms): EvmTerms {
    return { ...terms, collateralRepaymentAmount: terms.collateralRepaymentAmount ?? 0n };
  }

  readonly manifest: DeploymentManifest;
  readonly clients: Record<Chain, PublicClient>;
  private readonly logClients: Record<Chain, PublicClient>;
  private verified?: Promise<void>;
  private immutableToken?: Promise<Address>;
  private readonly loanReads = new Map<string, Promise<EvmLoan>>();
  constructor(readonly config: EvmReaderConfig) {
    this.manifest = deploymentSchema.parse(config.manifest);
    this.clients = {
      hedera: createPublicClient({
        transport: http(config.rpc.hedera, { timeout: 20_000, retryCount: 2, batch: true }),
        pollingInterval: 2000,
        ccipRead: false,
      }),
      base: createPublicClient({
        transport: http(config.rpc.base, { timeout: 20_000, retryCount: 2, batch: true }),
        pollingInterval: 2000,
        ccipRead: false,
      }),
    };
    // Hedera disallows eth_getLogs in JSON-RPC batches, even though ordinary reads support batching.
    this.logClients = {
      hedera: createPublicClient({
        transport: http(config.rpc.hedera, { timeout: 20_000, retryCount: 2 }),
      }),
      base: createPublicClient({
        transport: http(config.rpc.base, { timeout: 20_000, retryCount: 2 }),
      }),
    };
  }
  address(chain: Chain): Address {
    return this.manifest[chain].contract as Address;
  }
  async verifyDeployment(manifest: DeploymentManifest = this.manifest): Promise<void> {
    if (JSON.stringify(deploymentSchema.parse(manifest)) !== JSON.stringify(this.manifest))
      throw new HedgeError(
        "INSTANCE_MISMATCH",
        "Adapter configuration differs from this deployment",
      );
    this.verified ??= this.verify().catch((error) => {
      this.verified = undefined;
      throw error;
    });
    return this.verified;
  }
  private async verify(): Promise<void> {
    await Promise.all(
      (["hedera", "base"] as const).map(async (chain) => {
        const config = this.manifest[chain],
          other = this.manifest[chain === "hedera" ? "base" : "hedera"],
          client = this.clients[chain];
        const [chainId, code] = await Promise.all([
          client.getChainId(),
          client.getCode({ address: this.address(chain) }),
        ]);
        if (chainId !== config.chain_id || !code || !sameAddress(keccak256(code), config.code_hash))
          throw new HedgeError(
            "DEPLOYMENT_MISMATCH",
            `${chain} chain or runtime code does not match`,
          );
        const fields = [
          "instanceId",
          "peer",
          "deployer",
          "protocolVersion",
          "router",
          "localChainId",
          "remoteChainId",
          "localSelector",
          "remoteSelector",
          "requestedFinalityConfig",
          "allowedFinalityConfig",
        ] as const;
        const expected = [
          this.manifest.instance_id,
          other.contract,
          this.manifest.deployer,
          this.manifest.protocol_version,
          config.router,
          BigInt(config.chain_id),
          BigInt(other.chain_id),
          BigInt(config.selector),
          BigInt(other.selector),
          config.ccip_policy?.requested_finality ?? "0x00000000",
          config.ccip_policy?.allowed_finality ?? "0x00000000",
        ];
        const values = await Promise.all(
          fields.map((functionName) =>
            client.readContract({
              address: this.address(chain),
              abi: this.lendingAbi,
              functionName,
            }),
          ),
        );
        // The manifest deployer configures Hedera. Base's setup signer is bound by its runtime hash.
        if (
          values.some(
            (value, index) =>
              (chain !== "base" || fields[index] !== "deployer") &&
              String(value).toLowerCase() !== String(expected[index]).toLowerCase(),
          )
        )
          throw new HedgeError(
            "DEPLOYMENT_MISMATCH",
            `${chain} peer, instance or immutable policy does not match`,
          );
        const asset = await client.readContract({
          address: this.address(chain),
          abi: this.lendingAbi,
          functionName: "collateralAsset",
        });
        const remoteAsset = await this.clients[chain === "hedera" ? "base" : "hedera"].readContract(
          {
            address: this.address(chain === "hedera" ? "base" : "hedera"),
            abi: this.lendingAbi,
            functionName: "collateralAsset",
          },
        );
        if (!sameAddress(asset, remoteAsset))
          throw new HedgeError("ASSET_MISMATCH", "The lending and custody assets differ");
      }),
    );
  }
  loan(id: string): Promise<EvmLoan> {
    const existing = this.loanReads.get(id);
    if (existing) return existing;
    const read = this.readLoan(id).finally(() => this.loanReads.delete(id));
    this.loanReads.set(id, read);
    return read;
  }
  private async readLoan(id: string): Promise<EvmLoan> {
    await this.verifyDeployment();
    const loan = await this.clients.hedera.readContract({
      address: this.address("hedera"),
      abi: this.lendingAbi,
      functionName: "getLoan",
      args: [id as Hex],
    });
    loan.agreement.terms = this.normalizeTerms(loan.agreement.terms);
    const a = loan.agreement,
      m = this.manifest;
    if (loan.state === 0)
      throw new HedgeError("CREDIT_UNAVAILABLE", "This loan is not confirmed on Hedera yet");
    if (
      a.version !== this.manifest.protocol_version ||
      a.instanceId !== m.instance_id ||
      a.loanId !== id ||
      a.loanId !== loanId(a.instanceId, a.offerId, a.version) ||
      !sameAddress(a.lending, m.hedera.contract) ||
      !sameAddress(a.vault, m.base.contract) ||
      /^0x0{40}$/i.test(a.operator) ||
      a.hederaChainId !== BigInt(m.hedera.chain_id) ||
      a.baseChainId !== BigInt(m.base.chain_id) ||
      a.hederaSelector !== BigInt(m.hedera.selector) ||
      a.baseSelector !== BigInt(m.base.selector) ||
      agreementHash(a) !== loan.agreementHash
    )
      throw new HedgeError("AGREEMENT_MISMATCH", "The canonical agreement binding is invalid");
    const token = await this.loanToken();
    if (
      !sameAddress(a.loanToken, token) ||
      !sameAddress(a.terms.borrower, a.terms.fundingRecipient)
    )
      throw new HedgeError("AGREEMENT_MISMATCH", "The loan token or recipient is invalid");
    return loan;
  }
  loanToken() {
    // Immutable in the verified lending runtime. Failed reads are never cached.
    this.immutableToken ??= this.clients.hedera
      .readContract({
        address: this.address("hedera"),
        abi: this.lendingAbi,
        functionName: "loanToken",
      })
      .catch((error) => {
        this.immutableToken = undefined;
        throw error;
      });
    return this.immutableToken;
  }
  custody(id: string) {
    return this.clients.base.readContract({
      address: this.address("base"),
      abi: this.vaultAbi,
      functionName: "getCustody",
      args: [id as Hex],
    });
  }
  async projectOffer(id: Hex, terms: EvmTerms, hash: Hex, operator: Address): Promise<Offer> {
    const token = await this.loanToken();
    if (
      termsHash(
        this.manifest.instance_id as Hex,
        id,
        token,
        terms,
        operator,
        this.manifest.protocol_version,
      ) !== hash
    )
      throw new HedgeError("OFFER_MISMATCH", "Offer terms do not match the canonical hash");
    return {
      id,
      instance_id: this.manifest.instance_id,
      terms_hash: hash,
      operator,
      policy_hash: terms.policyHash,
      funding: {
        token,
        amount: terms.principal,
        recipient: {
          address: terms.fundingRecipient,
          account_id: await this.config.resolveAccount(terms.fundingRecipient),
        },
      },
      repayment_amount: terms.repaymentAmount,
      acceptance_deadline: Number(terms.acceptanceDeadline),
      setup_deadline: Number(terms.setupDeadline),
      duration: terms.duration,
      grace_period: terms.gracePeriod,
      collateral: {
        asset: terms.collateralAsset,
        amount: terms.collateralAmount,
        owner: terms.collateralOwner,
        return_recipient: terms.returnRecipient,
        recovery_recipient: terms.recoveryRecipient,
        repayment_amount: terms.collateralRepaymentAmount,
      },
    };
  }
  async offer(id: string): Promise<Offer> {
    await this.verifyDeployment();
    const raw = await this.clients.hedera.readContract({
      address: this.address("hedera"),
      abi: this.lendingAbi,
      functionName: "getOffer",
      args: [id as Hex],
    });
    if (raw.state === 0) throw new HedgeError("OFFER_UNAVAILABLE", "Offer does not exist");
    return this.projectOffer(
      id as Hex,
      this.normalizeTerms(raw.terms),
      raw.termsHash,
      raw.operator,
    );
  }
  async agreement(id: string) {
    const raw = await this.loan(id);
    const offer = await this.offer(raw.agreement.offerId);
    // An accepted agreement, rather than a service's offer projection, owns these terms.
    if (
      termsHash(
        this.manifest.instance_id as Hex,
        raw.agreement.offerId,
        raw.agreement.loanToken,
        raw.agreement.terms,
        raw.agreement.operator,
        this.manifest.protocol_version,
      ) !== offer.terms_hash ||
      !sameAddress(raw.agreement.operator, offer.operator)
    )
      throw new HedgeError("AGREEMENT_MISMATCH", "Accepted terms differ from the offer");
    return {
      instance_id: this.manifest.instance_id,
      credit_id: id,
      agreement_hash: raw.agreementHash,
      offer,
    };
  }
  async summary(id: string): Promise<CreditSummary> {
    const [loan, custody] = await Promise.all([this.loan(id), this.custody(id)]);
    if (
      custody.authorized &&
      (custody.agreementHash !== loan.agreementHash ||
        agreementHash(custody.agreement) !== loan.agreementHash)
    )
      throw new HedgeError("AGREEMENT_MISMATCH", "Base custody belongs to a different agreement");
    const state = (["accepted", "funded", "repaid", "cancelled", "defaulted", "settling"] as const)[
      loan.state - 1
    ];
    if (!state) throw new HedgeError("CREDIT_UNAVAILABLE", "Unknown canonical loan state");
    let collateral: CreditSummary["collateral_state"] = "unlocked";
    if (custody.locked) {
      collateral = custody.claimed
        ? custody.outcome === 2
          ? "recovered"
          : custody.outcome === 3
            ? "settled"
            : "returned"
        : custody.outcome === 1
          ? "return_authorized"
          : custody.outcome === 3
            ? "settlement_authorized"
            : custody.outcome === 2
              ? "recovery_authorized"
              : state === "settling"
                ? "settlement_pending"
                : state === "defaulted"
                  ? "recovery_pending"
                  : state === "repaid" || state === "cancelled"
                    ? "return_pending"
                    : "locked";
    }
    return {
      instance_id: this.manifest.instance_id,
      credit_id: id,
      agreement_hash: loan.agreementHash,
      state,
      collateral_state: collateral,
      amount_due:
        state === "funded" || state === "defaulted" || state === "settling"
          ? loan.agreement.terms.repaymentAmount
          : 0n,
      payment_deadline: loan.paymentDeadline ? Number(loan.paymentDeadline) : null,
    };
  }
  /** Recover outstanding loans from canonical agreements, including when browser storage was cleared. */
  async outstandingLoans(borrower: string) {
    const ids = new Set<string>();
    for (const log of await this.logs("hedera")) {
      try {
        const event = decodeEventLog({ abi: this.lendingAbi, data: log.data, topics: log.topics });
        if (event.eventName === "LoanAccepted") ids.add(event.args.loanId);
      } catch {
        // Other contract events are not loan creation.
      }
    }
    const outstanding: string[] = [];
    for (const id of ids) {
      const loan = await this.loan(id);
      if (!sameAddress(loan.agreement.terms.borrower, borrower)) continue;
      const summary = await this.summary(id);
      if (
        !(
          ["returned", "recovered"].includes(summary.collateral_state) ||
          (summary.collateral_state === "settled" && summary.state === "repaid")
        ) &&
        !(summary.state === "cancelled" && summary.collateral_state === "unlocked")
      )
        outstanding.push(id);
    }
    return outstanding;
  }
  async logs(chain: Chain, fromBlock = this.config.startBlock[chain]) {
    const client = this.clients[chain],
      end = await client.getBlockNumber(),
      logs = [];
    for (let start = fromBlock; start <= end; start += 1000n) {
      logs.push(
        ...(await this.logClients[chain].getLogs({
          address: this.address(chain),
          fromBlock: start,
          toBlock: start + 999n > end ? end : start + 999n,
        })),
      );
    }
    return logs;
  }
  async confirmed(chain: Chain, hash: Hex) {
    const client = this.clients[chain];
    const end = Date.now() + 90_000;
    for (;;) {
      const receipt = await client.getTransactionReceipt({ hash }).catch((error) => {
        if (error?.name === "TransactionReceiptNotFoundError") return undefined;
        throw error;
      });
      if (receipt) {
        if (receipt.status !== "success")
          throw new HedgeError("TRANSACTION_REVERTED", "The transaction reverted");
        const head = await client.getBlockNumber({ cacheTime: 0 });
        if (head >= receipt.blockNumber + (chain === "base" ? 3n : 0n)) {
          const [block, current] = await Promise.all([
            client.getBlock({ blockNumber: receipt.blockNumber }),
            client.getTransactionReceipt({ hash }),
          ]);
          if (
            block.hash === receipt.blockHash &&
            current.blockHash === receipt.blockHash &&
            current.status === "success"
          )
            return current;
        }
      }
      if (Date.now() > end)
        throw new HedgeError("CONFIRMATION_PENDING", `Confirmation pending for ${hash}`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  async token(chain: Chain, address: string): Promise<TokenMetadata> {
    const client = this.clients[chain];
    const [symbol, decimals] = await Promise.all([
      client.readContract({ address: address as Address, abi: tokenAbi, functionName: "symbol" }),
      client.readContract({ address: address as Address, abi: tokenAbi, functionName: "decimals" }),
    ]);
    return { chain_id: this.manifest[chain].chain_id, address, symbol, decimals };
  }
  async outbox(id: string, kind: number) {
    if (
      !Number.isInteger(kind) ||
      kind < 0 ||
      kind > (this.manifest.protocol_version === 3 ? 3 : 2)
    )
      throw new HedgeError("INVALID_MESSAGE_KIND", "Unsupported CCIP obligation");
    const chain: Chain = kind === 1 || kind === 3 ? "base" : "hedera",
      client = this.clients[chain],
      address = this.address(chain);
    const operation = await client.readContract({
      address,
      abi: this.lendingAbi,
      functionName: "operationId",
      args: [id as Hex, kind],
    });
    const box = await client.readContract({
      address,
      abi: this.lendingAbi,
      functionName: "getOutbox",
      args: [operation],
    });
    const receiver = chain === "base" ? "hedera" : "base";
    const fingerprint =
      box.lastMessageId !== zero
        ? await this.clients[receiver].readContract({
            address: this.address(receiver),
            abi: this.lendingAbi,
            functionName: "receivedMessages",
            args: [box.lastMessageId],
          })
        : zero;
    if (fingerprint !== zero && fingerprint !== keccak256(box.payload))
      throw new HedgeError(
        "MESSAGE_MISMATCH",
        "The destination marker does not match the immutable CCIP payload",
      );
    const delivered = fingerprint !== zero;
    return { chain, operation, ...box, delivered };
  }
}
