import { encodeFunctionData, decodeEventLog, type Address, type Hex } from "viem";
import { addressSchema } from "@hedge/schema";
import type {
  LoanRequest,
  Offer,
  FundingResult,
  ConfirmedTransaction,
  DeploymentManifest,
  Chain,
  WalletIdentity,
} from "@hedge/schema";
import type {
  HedgeAdapter,
  AcceptOptions,
  OperationOptions,
  Checkpoint,
  TokenAmount,
} from "../types/adapter.types";
import { HedgeError, PendingError } from "../client/hedge-error";
import { EvmHedgeReader, loanId, termsHash, tokenAbi } from "./chain-reader";
import { sameAddress } from "./address";
import { delegationManager, matchesDelegatedCall } from "./delegated-call";

export interface EvmTransaction {
  chain: Chain;
  to: Address;
  data: Hex;
  value?: bigint;
  label: string;
  key: string;
}
export interface EvmWallet {
  wallet(chain: Chain): Promise<WalletIdentity | null>;
  connect(chain: Chain): Promise<WalletIdentity>;
  signMessage?(chain: Chain, message: string): Promise<Hex>;
  /** Must obtain explicit wallet approval and preserve the hash immediately after broadcast. */
  send(transaction: EvmTransaction): Promise<Hex>;
}
export interface EvmJournal {
  get(key: string): Hex | undefined;
  set(key: string, hash: Hex): void | Promise<void>;
  checkpoint?(checkpoint: Checkpoint): void;
}
export interface EvmAdapterOptions {
  reader: EvmHedgeReader;
  operator: string;
  wallet: EvmWallet;
  journal: EvmJournal;
  discover(request: LoanRequest, baseOwner: string): Promise<readonly string[]>;
  /** Sponsor the contract's immutable outbox. Delivery is always checked on the destination. */
  relay(creditId: string): Promise<void>;
  waitMs?: number;
}
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class EvmHedgeAdapter implements HedgeAdapter {
  readonly reader: EvmHedgeReader;
  private mutations = new Set<string>();
  private eventCache?: Awaited<ReturnType<EvmHedgeReader["logs"]>>;
  private eventBlock?: bigint;
  constructor(readonly options: EvmAdapterOptions) {
    addressSchema.parse(options.operator);
    if (/^0x0{40}$/i.test(options.operator))
      throw new HedgeError("OPERATOR_MISMATCH", "Select a nonzero operator wallet");
    this.reader = options.reader;
  }
  verifyDeployment(manifest: DeploymentManifest) {
    return this.reader.verifyDeployment(manifest);
  }
  async loanToken() {
    return this.reader.token("hedera", await this.reader.loanToken());
  }
  async outstandingLoans(borrower: string) {
    const ids = await this.reader.outstandingLoans(borrower);
    const loans = await Promise.all(
      ids.map(async (id) => ({ id, loan: await this.reader.loan(id) })),
    );
    return loans
      .filter(({ loan }) => sameAddress(loan.agreement.operator, this.options.operator))
      .map(({ id }) => id);
  }
  private progress(
    id: string,
    stage: string,
    options?: OperationOptions,
    transaction?: ConfirmedTransaction,
  ) {
    const checkpoint = {
      instance_id: this.reader.manifest.instance_id,
      credit_id: id,
      stage,
      ...(transaction ? { transaction } : {}),
    };
    this.options.journal.checkpoint?.(checkpoint);
    options?.on_progress?.(checkpoint);
  }
  private async exclusive<T>(id: string, action: () => Promise<T>): Promise<T> {
    if (this.mutations.has(id))
      throw new HedgeError("OPERATION_BUSY", "This loan operation is already running");
    this.mutations.add(id);
    try {
      return await action();
    } finally {
      this.mutations.delete(id);
    }
  }
  async identity(chain: Chain, expected?: string) {
    const wallet =
      (await this.options.wallet.wallet(chain)) ?? (await this.options.wallet.connect(chain));
    if (
      wallet.chain_id !== this.reader.manifest[chain].chain_id ||
      (expected && !sameAddress(wallet.address, expected))
    )
      throw new HedgeError("WALLET_MISMATCH", `Connect the agreed ${chain} wallet`);
    if (
      chain === "hedera" &&
      wallet.account_id !== (await this.reader.config.resolveAccount(wallet.address))
    )
      throw new HedgeError("WALLET_MISMATCH", "Hedera address and account identity do not match");
    return wallet;
  }
  async transact(
    tx: Omit<EvmTransaction, "key"> & { key: string },
    id?: string,
    options?: OperationOptions,
  ): Promise<ConfirmedTransaction> {
    await this.reader.verifyDeployment();
    const signer = await this.identity(tx.chain);
    const key = `${this.reader.manifest.instance_id}:${tx.chain}:${tx.key}`;
    let hash = this.options.journal.get(key);
    if (!hash) {
      if (id && tx.key !== `${id}-accept`) this.progress(id, `${tx.key}_signature`, options);
      hash = await this.options.wallet.send({ ...tx, key });
      await this.options.journal.set(key, hash);
    }
    if (id) this.progress(id, `${tx.key}_submitted`, options);
    try {
      const receipt = await this.reader.confirmed(tx.chain, hash);
      const observed = await this.reader.clients[tx.chain].getTransaction({ hash });
      const direct =
        !!observed.to &&
        sameAddress(observed.to, tx.to) &&
        sameAddress(observed.from, signer.address) &&
        observed.input.toLowerCase() === tx.data.toLowerCase() &&
        observed.value === (tx.value ?? 0n);
      const delegated =
        !direct &&
        tx.chain === "base" &&
        !!observed.to &&
        sameAddress(observed.to, delegationManager) &&
        matchesDelegatedCall(
          tx,
          observed,
          signer.address,
          receipt,
          this.reader.address("base"),
          await this.reader.clients.base.readContract({
            address: this.reader.address("base"),
            abi: this.reader.vaultAbi,
            functionName: "collateralAsset",
          }),
        );
      if (!direct && !delegated)
        throw new HedgeError(
          "TRANSACTION_MISMATCH",
          "The saved transaction does not match this operation or wallet",
        );
      const confirmed: ConfirmedTransaction = { chain: tx.chain, hash, confirmed: true };
      if (id) this.progress(id, tx.key, options, confirmed);
      return confirmed;
    } catch (error) {
      if (
        error instanceof HedgeError &&
        ["TRANSACTION_REVERTED", "TRANSACTION_MISMATCH"].includes(error.code)
      )
        throw error;
      if (id)
        throw new PendingError(
          `Transaction ${hash} is awaiting confirmation. Reopen this loan to check the same hash.`,
          { instance_id: this.reader.manifest.instance_id, credit_id: id, stage: tx.key },
        );
      throw error;
    }
  }
  async ensureAllowance(
    chain: Chain,
    token: Address,
    spender: Address,
    amount: bigint,
    owner: string,
    key: string,
    id?: string,
    options?: OperationOptions,
  ) {
    await this.identity(chain, owner);
    const client = this.reader.clients[chain];
    const balance = await client.readContract({
      address: token,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [owner as Address],
    });
    if (balance < amount)
      throw new HedgeError(
        "INSUFFICIENT_BALANCE",
        `Add ${chain === "hedera" ? "Hedera loan tokens" : "Base collateral"} to the agreed wallet`,
      );
    const allowance = await client.readContract({
      address: token,
      abi: tokenAbi,
      functionName: "allowance",
      args: [owner as Address, spender],
    });
    if (allowance >= amount) return;
    if (allowance > 0n)
      await this.transact(
        {
          chain,
          to: token,
          data: encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [spender, 0n] }),
          key: `${key}-reset`,
          label: "Reset token allowance",
        },
        id,
        options,
      );
    await this.transact(
      {
        chain,
        to: token,
        data: encodeFunctionData({
          abi: tokenAbi,
          functionName: "approve",
          args: [spender, amount],
        }),
        key: `${key}-approve`,
        label: chain === "base" ? "Approve collateral token" : "Approve USDC",
      },
      id,
      options,
    );
  }
  async offers(request: LoanRequest): Promise<Offer[]> {
    await this.reader.verifyDeployment();
    const hedera = await this.identity("hedera", request.funding.recipient.address),
      base = await this.identity("base");
    if (hedera.account_id !== request.funding.recipient.account_id)
      throw new HedgeError(
        "WALLET_MISMATCH",
        "Recipient account differs from the connected wallet",
      );
    const ids = await this.options.discover(request, base.address),
      results: Offer[] = [];
    const block = await this.reader.clients.hedera.getBlock({ blockTag: "latest" });
    for (const id of ids) {
      const raw = await this.reader.clients.hedera.readContract({
        address: this.reader.address("hedera"),
        abi: this.reader.lendingAbi,
        functionName: "getOffer",
        args: [id as Hex],
      });
      if (raw.state !== 1 || raw.terms.acceptanceDeadline <= block.timestamp) continue;
      const offer = await this.reader.offer(id);
      if (
        !sameAddress(offer.operator, this.options.operator) ||
        !sameAddress(offer.funding.token, request.funding.token) ||
        offer.funding.amount !== request.funding.amount ||
        !sameAddress(offer.funding.recipient.address, hedera.address) ||
        !sameAddress(offer.collateral.owner, base.address)
      )
        continue;
      if (request.credit && request.credit.duration !== offer.duration) continue;
      if (
        request.collateral &&
        (request.collateral.chain_id !== this.reader.manifest.base.chain_id ||
          !sameAddress(request.collateral.asset, offer.collateral.asset) ||
          request.collateral.amount !== offer.collateral.amount)
      )
        continue;
      results.push(offer);
    }
    return results;
  }
  accept(request: LoanRequest, options: AcceptOptions): Promise<FundingResult> {
    const id = loanId(
      this.reader.manifest.instance_id as Hex,
      options.offer_id as Hex,
      this.reader.manifest.protocol_version,
    );
    return this.exclusive(id, async () => {
      const offer = (await this.offers(request)).find((o) => o.id === options.offer_id);
      if (!offer || offer.terms_hash !== options.reviewedOffer.terms_hash)
        throw new HedgeError("OFFER_CHANGED", "Review the currently funded offer again");
      const owner = await this.identity("hedera", offer.funding.recipient.address);
      const associated = await this.reader.clients.hedera.readContract({
        address: offer.funding.token as Address,
        abi: tokenAbi,
        functionName: "isAssociated",
        account: owner.address as Address,
      });
      if (!associated)
        await this.transact({
          chain: "hedera",
          to: offer.funding.token as Address,
          data: encodeFunctionData({ abi: tokenAbi, functionName: "associate" }),
          key: `${id}-associate`,
          label: "Associate loan token",
        });
      await this.transact(
        {
          chain: "hedera",
          to: this.reader.address("hedera"),
          data: encodeFunctionData({
            abi: this.reader.lendingAbi,
            functionName: "accept",
            args: [offer.id as Hex, offer.terms_hash as Hex],
          }),
          key: `${id}-accept`,
          label: "Accept loan",
        },
        id,
        options,
      );
      await this.advance(id, options);
      const result = await this.funding(id).catch((error: unknown) => {
        if (error instanceof HedgeError && error.code === "FUNDING_PENDING") return null;
        throw error;
      });
      if (!result)
        throw new PendingError("Payout is still pending. Continue setup for this loan.", {
          instance_id: this.reader.manifest.instance_id,
          credit_id: id,
          stage: "funding_pending",
        });
      return result;
    });
  }
  private async advance(id: string, options?: OperationOptions) {
    let loan = await this.reader.loan(id);
    if (loan.state !== 1) {
      if (loan.state === 6) {
        await this.advanceSettlement(id, options);
        return;
      }
      await this.options.relay(id);
      return;
    }
    await this.identity("hedera", loan.agreement.terms.borrower);
    await this.options.relay(id);
    const waitMs = this.options.waitMs ?? 180_000;
    let deadline = Date.now() + waitMs;
    this.progress(id, "agreement_pending", options);
    for (;;) {
      loan = await this.reader.loan(id);
      if (loan.state !== 1) break;
      const custody = await this.reader.custody(id);
      if (custody.authorized && !custody.locked && custody.outcome === 0) {
        if (custody.agreementHash !== loan.agreementHash)
          throw new HedgeError("AGREEMENT_MISMATCH", "Base authorization differs from this loan");
        const terms = loan.agreement.terms;
        this.progress(id, "collateral_ready", options);
        await this.ensureAllowance(
          "base",
          terms.collateralAsset,
          this.reader.address("base"),
          terms.collateralAmount,
          terms.collateralOwner,
          `${id}-collateral`,
          id,
          options,
        );
        // Reconcile canonical state immediately before the irreversible pledge transaction.
        if ((await this.reader.loan(id)).state !== 1) break;
        await this.identity("base", terms.collateralOwner);
        await this.transact(
          {
            chain: "base",
            to: this.reader.address("base"),
            data: encodeFunctionData({
              abi: this.reader.vaultAbi,
              functionName: "lock",
              args: [id as Hex, loan.agreementHash],
            }),
            key: `${id}-lock`,
            label: "Lock Base collateral",
          },
          id,
          options,
        );
        this.progress(id, "custody_pending", options);
        await this.options.relay(id);
        deadline = Date.now() + waitMs;
      }
      if (Date.now() > deadline)
        throw new PendingError("CCIP delivery is pending. Your saved loan can be resumed.", {
          instance_id: this.reader.manifest.instance_id,
          credit_id: id,
          stage: custody.locked ? "custody_pending" : "agreement_pending",
        });
      await pause(3000);
    }
    this.progress(id, loan.state === 2 ? "funded" : "outcome_pending", options);
  }
  async summary(id: string) {
    const accept = this.options.journal.get(
      `${this.reader.manifest.instance_id}:hedera:${id}-accept`,
    );
    if (accept) await this.reader.confirmed("hedera", accept);
    return this.reader.summary(id);
  }
  async funding(id: string): Promise<FundingResult | null> {
    const loan = await this.reader.loan(id);
    if (!loan.fundedAt) return null;
    // LoanFunded and a successful canonical receipt are required, even after repayment.
    const client = this.reader.clients.hedera;
    const head = await client.getBlockNumber();
    if (!this.eventCache) this.eventCache = await this.reader.logs("hedera");
    else if (this.eventBlock !== undefined && head > this.eventBlock)
      this.eventCache.push(...(await this.reader.logs("hedera", this.eventBlock + 1n)));
    this.eventBlock = head;
    const log = this.eventCache.find((log) => {
      try {
        const decoded = decodeEventLog({
          abi: this.reader.lendingAbi,
          data: log.data,
          topics: log.topics,
        });
        return (
          decoded.eventName === "LoanFunded" &&
          decoded.args.loanId === id &&
          sameAddress(decoded.args.recipient, loan.agreement.terms.fundingRecipient) &&
          decoded.args.principal === loan.agreement.terms.principal &&
          decoded.args.paymentDeadline === loan.paymentDeadline
        );
      } catch {
        return false;
      }
    });
    if (!log?.transactionHash) {
      // The relay can expose loan state before the mirror node indexes its payout event.
      this.eventCache = undefined;
      this.eventBlock = undefined;
      throw new HedgeError("FUNDING_PENDING", "The confirmed payout receipt is not available yet");
    }
    const receipt = await this.reader.confirmed("hedera", log.transactionHash);
    if (receipt.blockHash !== log.blockHash) {
      this.eventCache = undefined;
      throw new HedgeError("FUNDING_PENDING", "Payout observation changed; refresh the loan");
    }
    const offer = await this.reader.offer(loan.agreement.offerId);
    return {
      instance_id: this.reader.manifest.instance_id,
      credit_id: id,
      offer_id: offer.id,
      agreement_hash: loan.agreementHash,
      funding: offer.funding,
      transaction: { chain: "hedera", hash: log.transactionHash, confirmed: true },
    };
  }
  resume(id: string, options?: OperationOptions) {
    return this.exclusive(id, async () => {
      await this.advance(id, options);
      return this.summary(id);
    });
  }
  async cancel(id: string, options?: OperationOptions) {
    return this.exclusive(id, async () => {
      const loan = await this.reader.loan(id);
      await this.identity("hedera", loan.agreement.terms.borrower);
      if (loan.state !== 1)
        throw new HedgeError("CANCEL_UNAVAILABLE", "Only an unfunded loan can be cancelled");
      const result = await this.transact(
        {
          chain: "hedera",
          to: this.reader.address("hedera"),
          data: encodeFunctionData({
            abi: this.reader.lendingAbi,
            functionName: "cancel",
            args: [id as Hex],
          }),
          key: `${id}-cancel`,
          label: "Cancel loan setup",
        },
        id,
        options,
      );
      await this.options.relay(id);
      return result;
    });
  }
  async repay(
    id: string,
    args: { amount: bigint | "max"; from: "wallet" },
    options?: OperationOptions,
  ) {
    return this.exclusive(id, async () => {
      const loan = await this.reader.loan(id),
        terms = loan.agreement.terms;
      if (loan.state !== 2 || (args.amount !== "max" && args.amount !== terms.repaymentAmount))
        throw new HedgeError("REPAYMENT_CHANGED", "Review the current full repayment");
      await this.identity("hedera", terms.borrower);
      await this.ensureAllowance(
        "hedera",
        loan.agreement.loanToken,
        this.reader.address("hedera"),
        terms.repaymentAmount,
        terms.borrower,
        `${id}-repayment`,
        id,
        options,
      );
      if ((await this.reader.loan(id)).state !== 2)
        throw new HedgeError("REPAYMENT_CHANGED", "Loan state changed before signing");
      const result = await this.transact(
        {
          chain: "hedera",
          to: this.reader.address("hedera"),
          data: encodeFunctionData({
            abi: this.reader.lendingAbi,
            functionName: "repay",
            args: [id as Hex, terms.repaymentAmount],
          }),
          key: `${id}-repay`,
          label: "Repay loan in full",
        },
        id,
        options,
      );
      await this.options.relay(id);
      return result;
    });
  }
  async collateralStatus(id: string) {
    return { state: (await this.summary(id)).collateral_state };
  }
  async repayWithCollateral(id: string, agreementHash: string, options?: OperationOptions) {
    return this.exclusive(id, async () => {
      const loan = await this.reader.loan(id);
      if (
        this.reader.manifest.protocol_version < 3 ||
        loan.agreement.terms.collateralRepaymentAmount <= 0n
      )
        throw new HedgeError(
          "COLLATERAL_REPAYMENT_UNAVAILABLE",
          "The operator has not agreed to repayment with collateral",
        );
      if (loan.agreementHash !== agreementHash || ![2, 6].includes(loan.state))
        throw new HedgeError("REPAYMENT_CHANGED", "Review the accepted collateral repayment terms");
      await this.identity("hedera", loan.agreement.terms.borrower);
      if (loan.state === 2) {
        await this.transact(
          {
            chain: "hedera",
            to: this.reader.address("hedera"),
            data: encodeFunctionData({
              abi: this.reader.lendingAbi,
              functionName: "repayWithCollateral",
              args: [id as Hex, agreementHash as Hex],
            }),
            key: `${id}-collateral-request`,
            label: "Authorize repayment with Base collateral",
          },
          id,
          options,
        );
      }
      await this.advanceSettlement(id, options);
      return this.reader.summary(id);
    });
  }
  private async advanceSettlement(id: string, options?: OperationOptions) {
    const deadline = Date.now() + (this.options.waitMs ?? 180_000);
    for (;;) {
      const loan = await this.reader.loan(id);
      if (loan.state === 3) return;
      if (loan.state !== 6)
        throw new HedgeError("REPAYMENT_CHANGED", "Collateral settlement is not pending");
      await this.options.relay(id);
      const custody = await this.reader.custody(id);
      if (custody.outcome === 3 && !custody.claimed) {
        await this.identity("base", loan.agreement.terms.collateralOwner);
        this.progress(id, "settlement_ready", options);
        await this.transact(
          {
            chain: "base",
            to: this.reader.address("base"),
            data: encodeFunctionData({
              abi: this.reader.vaultAbi,
              functionName: "settle",
              args: [id as Hex],
            }),
            key: `${id}-settle`,
            label: "Pay the operator and return remaining collateral",
          },
          id,
          options,
        );
        await this.options.relay(id);
      }
      const stage = custody.claimed ? "settlement_confirmation_pending" : "settlement_pending";
      this.progress(id, stage, options);
      if (Date.now() > deadline)
        throw new PendingError(
          "Cross-chain repayment confirmation is pending. Resume this same loan.",
          { instance_id: this.reader.manifest.instance_id, credit_id: id, stage },
        );
      await pause(3000);
    }
  }
  private async claim(id: string, recovery: boolean, options?: OperationOptions) {
    const loan = await this.reader.loan(id),
      custody = await this.reader.custody(id);
    const recipient = recovery
      ? loan.agreement.terms.recoveryRecipient
      : loan.agreement.terms.returnRecipient;
    await this.identity("base", recipient);
    if (!custody.locked || custody.outcome !== (recovery ? 2 : 1))
      throw new PendingError("Base is still awaiting the canonical collateral outcome", {
        instance_id: this.reader.manifest.instance_id,
        credit_id: id,
        stage: "outcome_pending",
      });
    const result = await this.transact(
      {
        chain: "base",
        to: this.reader.address("base"),
        data: encodeFunctionData({
          abi: this.reader.vaultAbi,
          functionName: "claim",
          args: [id as Hex],
        }),
        key: `${id}-claim`,
        label: recovery ? "Claim recovery collateral" : "Claim returned collateral",
      },
      id,
      options,
    );
    if (!(await this.reader.custody(id)).claimed)
      throw new HedgeError("CLAIM_PENDING", "The collateral claim has not completed");
    return result;
  }
  claimCollateral(id: string, options?: OperationOptions) {
    return this.exclusive(id, () => this.claim(id, false, options));
  }
  claimRecovery(operator: string, id: string) {
    return this.exclusive(id, async () => {
      const loan = await this.reader.loan(id);
      if (!sameAddress(loan.agreement.operator, operator))
        throw new HedgeError("OPERATOR_MISMATCH", "Loan belongs to another operator");
      return this.claim(id, true);
    });
  }
  async activity(id: string) {
    await this.reader.loan(id);
    const results = [];
    for (const chain of ["hedera", "base"] as const)
      for (const log of await this.reader.logs(chain)) {
        let stage: string | undefined;
        try {
          const event = decodeEventLog({
            abi: chain === "hedera" ? this.reader.lendingAbi : this.reader.vaultAbi,
            data: log.data,
            topics: log.topics,
          });
          if ("loanId" in event.args && event.args.loanId === id && log.transactionHash)
            stage = event.eventName;
        } catch {
          /* Unrelated event. */
        }
        if (stage && log.transactionHash) {
          const receipt = await this.reader.confirmed(chain, log.transactionHash);
          if (receipt.blockHash !== log.blockHash)
            throw new HedgeError("CONFIRMATION_PENDING", "Activity observation changed");
          results.push({
            stage,
            transaction: { chain, hash: log.transactionHash, confirmed: true as const },
          });
        }
      }
    return results;
  }
  subscribe(id: string, callback: Parameters<HedgeAdapter["subscribe"]>[1]) {
    let stopped = false,
      running = false;
    const tick = async () => {
      if (stopped || running) return;
      running = true;
      try {
        const summary = await this.summary(id);
        if (!stopped) callback(summary);
      } catch {
        /* A failed read must never be projected as progress. */
      } finally {
        running = false;
      }
    };
    const timer = setInterval(() => void tick(), 3000);
    void tick();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }
  async operatorSummary(operator: string) {
    await this.reader.verifyDeployment();
    const [free_capital, reserved_capital] = await Promise.all(
      ["freeCapital", "reservedCapital"].map((functionName) =>
        this.reader.clients.hedera.readContract({
          address: this.reader.address("hedera"),
          abi: this.reader.lendingAbi,
          functionName: functionName as "freeCapital" | "reservedCapital",
          args: [operator as Address],
        }),
      ),
    );
    return {
      instance_id: this.reader.manifest.instance_id,
      operator,
      free_capital,
      reserved_capital,
    };
  }
  private async operatorTx(operator: string, name: "deposit" | "withdraw", args: TokenAmount) {
    await this.identity("hedera", operator);
    const token = await this.reader.loanToken();
    if (!sameAddress(token, args.token))
      throw new HedgeError("TOKEN_MISMATCH", "Use this instance's loan token");
    const key = `${operator}-${name}-${Date.now()}`;
    if (name === "deposit")
      await this.ensureAllowance(
        "hedera",
        token,
        this.reader.address("hedera"),
        args.amount,
        operator,
        key,
      );
    return this.transact({
      chain: "hedera",
      to: this.reader.address("hedera"),
      data: encodeFunctionData({
        abi: this.reader.lendingAbi,
        functionName: name,
        args: [args.amount],
      }),
      key,
      label: name === "deposit" ? "Deposit lending capital" : "Withdraw free capital",
    });
  }
  deposit(operator: string, args: TokenAmount) {
    return this.operatorTx(operator, "deposit", args);
  }
  withdraw(operator: string, args: TokenAmount) {
    return this.operatorTx(operator, "withdraw", args);
  }
  offer(id: string) {
    return this.reader.offer(id);
  }
  async operatorOffers(operator: string) {
    const ids = (await this.reader.logs("hedera")).flatMap((log) => {
      try {
        const event = decodeEventLog({
          abi: this.reader.lendingAbi,
          data: log.data,
          topics: log.topics,
        });
        return event.eventName === "OfferPublished" && sameAddress(event.args.operator, operator)
          ? [event.args.offerId]
          : [];
      } catch {
        return [];
      }
    });
    return Promise.all(ids.map((id) => this.offer(id)));
  }
  async publishOffer(operator: string, offer: Offer): Promise<ConfirmedTransaction> {
    await this.identity("hedera", operator);
    if (
      !sameAddress(offer.operator, operator) ||
      !offer.policy_hash ||
      offer.instance_id !== this.reader.manifest.instance_id ||
      !sameAddress(offer.funding.token, await this.reader.loanToken())
    )
      throw new HedgeError(
        "CANONICAL_TERMS_REQUIRED",
        "Provide the canonical policy hash and this instance's loan token",
      );
    const terms = {
      borrower: offer.funding.recipient.address as Address,
      fundingRecipient: offer.funding.recipient.address as Address,
      principal: offer.funding.amount,
      repaymentAmount: offer.repayment_amount,
      collateralAsset: offer.collateral.asset as Address,
      collateralAmount: offer.collateral.amount,
      collateralOwner: offer.collateral.owner as Address,
      returnRecipient: offer.collateral.return_recipient as Address,
      recoveryRecipient: offer.collateral.recovery_recipient as Address,
      acceptanceDeadline: BigInt(offer.acceptance_deadline),
      setupDeadline: BigInt(offer.setup_deadline),
      duration: offer.duration,
      gracePeriod: offer.grace_period,
      policyHash: offer.policy_hash as Hex,
      collateralRepaymentAmount: offer.collateral.repayment_amount ?? 0n,
    };
    if (
      termsHash(
        offer.instance_id as Hex,
        offer.id as Hex,
        offer.funding.token as Address,
        terms,
        operator as Address,
        this.reader.manifest.protocol_version,
      ) !== offer.terms_hash
    )
      throw new HedgeError("OFFER_MISMATCH", "The terms hash does not match the canonical offer");
    const result = await this.transact({
      chain: "hedera",
      to: this.reader.address("hedera"),
      data: encodeFunctionData({
        abi: this.reader.lendingAbi,
        functionName: "publishOffer",
        args: [terms],
      }),
      key: `${offer.id}-publish`,
      label: "Publish funded offer",
    });
    if ((await this.offer(offer.id)).terms_hash !== offer.terms_hash)
      throw new HedgeError("OFFER_MISMATCH", "The published offer ID or terms differ");
    return result;
  }
  async withdrawOffer(operator: string, id: string) {
    const offer = await this.reader.offer(id);
    if (!sameAddress(offer.operator, operator))
      throw new HedgeError("OPERATOR_MISMATCH", "Offer belongs to another operator");
    await this.identity("hedera", operator);
    return this.transact({
      chain: "hedera",
      to: this.reader.address("hedera"),
      data: encodeFunctionData({
        abi: this.reader.lendingAbi,
        functionName: "withdrawOffer",
        args: [id as Hex],
      }),
      key: `${id}-withdraw`,
      label: "Withdraw unaccepted offer",
    });
  }
  async authorizeDefault(operator: string, id: string) {
    await this.identity("hedera", operator);
    const loan = await this.reader.loan(id);
    if (!sameAddress(loan.agreement.operator, operator))
      throw new HedgeError("OPERATOR_MISMATCH", "Loan belongs to another operator");
    const result = await this.transact(
      {
        chain: "hedera",
        to: this.reader.address("hedera"),
        data: encodeFunctionData({
          abi: this.reader.lendingAbi,
          functionName: "authorizeDefault",
          args: [id as Hex],
        }),
        key: `${id}-default`,
        label: "Authorize eligible default",
      },
      id,
    );
    await this.options.relay(id);
    return result;
  }
}
