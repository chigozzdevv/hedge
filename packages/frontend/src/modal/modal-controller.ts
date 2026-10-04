import {
  HedgeError,
  PendingError,
  sameAddress,
  type Checkpoint,
  type HedgeClient,
  type ModalRenderer,
  type Offer,
  type Chain,
  type WalletIdentity,
  type TokenMetadata,
  type EvmHedgeAdapter,
  type FundingRequest,
  parseAmount,
} from "@hedge/sdk";
import {
  hashSchema,
  idSchema,
  offerSchema,
  tokenMetadataSchema,
  walletIdentitySchema,
  fundingRequestSchema,
  transactionSchema,
} from "@hedge/schema";
import type { ModalServices, ModalSnapshot, Screen, LoanTransactions } from "./modal-types";

const initial = (): ModalSnapshot => ({ open: false, screen: "connect", busy: false, offers: [] });
function errorMessage(error: unknown): string {
  if (
    error instanceof Error &&
    !/Request body:|HTTP request failed|Version: viem|Details:/i.test(error.message)
  )
    return error.message;
  return "Could not update this loan. Your progress is saved; retry when the connection is available.";
}

/** UI coordinator only. Every economic operation and confirmation comes from the configured SDK adapter. */
export class HedgeModalController {
  private snapshot = initial();
  private readonly listeners = new Set<() => void>();
  private readonly knownLoans = new Map<string, string>();
  private client?: HedgeClient;
  private requestedFunding?: FundingRequest;
  private resolve?: (selection: { credit_id: string } | null) => void;
  private refreshing = false;
  private loanRead: Promise<void> = Promise.resolve();
  private readonly transactionReads = new Set<string>();

  constructor(private readonly services: ModalServices) {}
  /** Restore a public ID only. Opening it always rereads the canonical agreement and receipts. */
  remember(checkpoint: Pick<Checkpoint, "instance_id" | "credit_id">) {
    this.knownLoans.set(
      idSchema.parse(checkpoint.instance_id),
      idSchema.parse(checkpoint.credit_id),
    );
    this.update({ creditId: checkpoint.credit_id });
  }
  getSnapshot = (): ModalSnapshot => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(values: Partial<ModalSnapshot>) {
    this.snapshot = Object.freeze({ ...this.snapshot, ...values });
    for (const listener of this.listeners) listener();
  }
  private requireClient() {
    if (!this.client) throw new HedgeError("MODAL_UNAVAILABLE", "Open Use Hedge first");
    return this.client;
  }
  private async run(action: () => Promise<void>) {
    if (this.snapshot.busy || !this.snapshot.open) return;
    this.update({ busy: true, error: undefined });
    try {
      await action();
    } catch (error) {
      let reportedError = error;
      if (error instanceof HedgeError && error.checkpoint) {
        try {
          this.checkpoint(error.checkpoint);
        } catch (boundaryError) {
          reportedError = boundaryError;
        }
      }
      if (reportedError instanceof PendingError) return;
      this.update({ error: errorMessage(reportedError) });
    } finally {
      this.update({ busy: false });
    }
  }
  private validateWallet(chain: Chain, wallet: WalletIdentity): WalletIdentity {
    const client = this.requireClient();
    walletIdentitySchema.parse(wallet);
    if (wallet.chain_id !== client.manifest[chain].chain_id)
      throw new HedgeError(
        "CHAIN_MISMATCH",
        `Connect the configured ${chain === "base" ? "Base" : "Hedera"} network`,
      );
    if (chain === "hedera" && !wallet.account_id)
      throw new HedgeError(
        "WALLET_MISMATCH",
        "The Hedera connector must resolve the account identity",
      );
    return Object.freeze({ ...wallet });
  }
  private async readWallets() {
    const [base, hedera] = await Promise.all([
      this.services.wallet("base"),
      this.services.wallet("hedera"),
    ]);
    this.update({
      base: base ? this.validateWallet("base", base) : undefined,
      hedera: hedera ? this.validateWallet("hedera", hedera) : undefined,
    });
  }
  private assertWallets(offer?: Offer) {
    const { base, hedera } = this.snapshot;
    if (!base || !hedera)
      throw new HedgeError("WALLET_UNAVAILABLE", "Connect both wallets to continue");
    const funding = offer?.funding ?? this.requestedFunding;
    if (
      funding &&
      (!sameAddress(hedera.address, funding.recipient.address) ||
        hedera.account_id !== funding.recipient.account_id)
    )
      throw new HedgeError("WALLET_MISMATCH", "Connect the Hedera wallet receiving this loan");
    if (offer && !sameAddress(base.address, offer.collateral.owner))
      throw new HedgeError("WALLET_MISMATCH", "Connect the Base wallet that owns this collateral");
  }
  private async walletFor(chain: Chain) {
    const current = await this.services.wallet(chain);
    const wallet = this.validateWallet(chain, current ?? (await this.services.connect(chain)));
    this.update({ [chain]: wallet });
    return wallet;
  }
  private assertBorrower(offer: Offer) {
    const wallet = this.snapshot.hedera;
    if (
      !wallet ||
      !sameAddress(wallet.address, offer.funding.recipient.address) ||
      wallet.account_id !== offer.funding.recipient.account_id
    )
      throw new HedgeError("WALLET_MISMATCH", "Connect the Hedera borrower wallet for this loan");
  }
  private validateToken(chain: Chain, address: string, value: TokenMetadata): TokenMetadata {
    const parsed = tokenMetadataSchema.safeParse(value);
    if (
      !parsed.success ||
      !sameAddress(address, value.address) ||
      value.chain_id !== this.requireClient().manifest[chain].chain_id
    )
      throw new HedgeError(
        "TOKEN_MISMATCH",
        "Token metadata does not match the selected asset and network",
      );
    return Object.freeze(parsed.data);
  }
  private async tokens(offer: Offer) {
    const [loan, collateral] = await Promise.all([
      this.services.token("hedera", offer.funding.token),
      this.services.token("base", offer.collateral.asset),
    ]);
    return {
      loanToken: this.validateToken("hedera", offer.funding.token, loan),
      collateralToken: this.validateToken("base", offer.collateral.asset, collateral),
    };
  }
  private validateOffer(value: Offer) {
    const offer = offerSchema.parse(value);
    if (
      offer.instance_id !== this.requireClient().manifest.instance_id ||
      offer.repayment_amount < offer.funding.amount ||
      (offer.collateral.repayment_amount ?? 0n) > offer.collateral.amount
    )
      throw new HedgeError(
        "OFFER_MISMATCH",
        "The offer does not match this deployment or supported repayment policy",
      );
    return Object.freeze({
      ...offer,
      funding: Object.freeze({
        ...offer.funding,
        recipient: Object.freeze({ ...offer.funding.recipient }),
      }),
      collateral: Object.freeze({ ...offer.collateral }),
    });
  }
  private checkpoint = (value: Checkpoint) => {
    if (value.instance_id !== this.requireClient().manifest.instance_id)
      throw new HedgeError("INSTANCE_MISMATCH", "Progress belongs to another deployment");
    const creditId = idSchema.parse(value.credit_id);
    if (this.snapshot.creditId && this.snapshot.creditId !== creditId)
      throw new HedgeError("CREDIT_MISMATCH", "Progress belongs to another loan");
    this.knownLoans.set(value.instance_id, creditId);
    const transactions = { ...this.snapshot.transactions };
    const kind =
      value.stage === `${creditId}-accept`
        ? "accept"
        : value.stage === `${creditId}-lock`
          ? "collateral"
          : value.stage === `${creditId}-collateral-request`
            ? "repaymentRequest"
            : value.stage === `${creditId}-settle`
              ? "settlement"
              : undefined;
    const transaction = transactionSchema.safeParse(value.transaction);
    if (
      kind &&
      transaction.success &&
      transaction.data.chain === (["collateral", "settlement"].includes(kind) ? "base" : "hedera")
    )
      transactions[kind] = transaction.data;
    this.update({
      creditId,
      checkpoint: { ...value },
      transactions,
      ...(this.snapshot.summary && this.snapshot.summary.state !== "accepted"
        ? {}
        : { screen: "setup" }),
    });
    try {
      this.services.onCheckpoint?.({ ...value });
    } catch {
      this.update({
        error: `Could not save the checkpoint. Keep loan ID ${creditId} to reopen it.`,
      });
    }
  };
  private readLoan() {
    const client = this.requireClient(),
      id = this.snapshot.creditId;
    if (!id) return Promise.resolve();
    const next = this.loanRead
      .catch(() => undefined)
      .then(async () => {
        if (this.client !== client || this.snapshot.creditId !== id) return;
        await this.readCurrentLoan(client, id);
      });
    this.loanRead = next;
    return next;
  }
  private async readCurrentLoan(client: HedgeClient, id: string) {
    const credit = client.credit(id);
    const [summary, terms, funding] = await Promise.all([
      credit.summary(),
      this.services.agreement(id),
      credit.funding().catch((error: unknown) => {
        if (error instanceof HedgeError && error.code === "FUNDING_PENDING") return null;
        throw error;
      }),
    ]);
    if (
      terms.credit_id !== id ||
      terms.instance_id !== client.manifest.instance_id ||
      hashSchema.parse(terms.agreement_hash).toLowerCase() !== summary.agreement_hash.toLowerCase()
    )
      throw new HedgeError(
        "AGREEMENT_MISMATCH",
        "Accepted terms do not match this loan's confirmed agreement",
      );
    const offer = this.validateOffer(terms.offer);
    const tokens = await this.tokens(offer);
    if (
      funding &&
      (funding.agreement_hash.toLowerCase() !== summary.agreement_hash.toLowerCase() ||
        funding.offer_id !== offer.id ||
        !sameAddress(funding.funding.token, offer.funding.token) ||
        funding.funding.amount !== offer.funding.amount ||
        !sameAddress(funding.funding.recipient.address, offer.funding.recipient.address) ||
        funding.funding.recipient.account_id !== offer.funding.recipient.account_id)
    )
      throw new HedgeError("FUNDING_MISMATCH", "The payout does not match the accepted loan");
    if (this.client !== client || this.snapshot.creditId !== id) return;
    const requested = this.requestedFunding;
    if (
      requested &&
      (requested.amount !== offer.funding.amount ||
        !sameAddress(requested.token, offer.funding.token) ||
        !sameAddress(requested.recipient.address, offer.funding.recipient.address) ||
        requested.recipient.account_id !== offer.funding.recipient.account_id)
    )
      throw new HedgeError(
        "FUNDING_MISMATCH",
        `Reopen existing loan ${id} before requesting different funding`,
      );
    let screen: Screen = "setup";
    if (summary.state === "funded" && funding)
      screen =
        this.snapshot.screen === "repay"
          ? "repay"
          : this.snapshot.screen === "manage"
            ? "manage"
            : "funded";
    else if (summary.state === "defaulted") screen = "defaulted";
    else if (summary.state === "settling") screen = "settle";
    else if (summary.state === "repaid" || summary.state === "cancelled") {
      screen = ["returned", "settled"].includes(summary.collateral_state)
        ? "complete"
        : summary.collateral_state === "unlocked" && summary.state === "cancelled"
          ? "cancelled"
          : "return";
    }
    if (summary.state === "accepted" && (!this.snapshot.base || !this.snapshot.hedera))
      screen = "connect";
    if (this.client !== client || this.snapshot.creditId !== id) return;
    const advanced =
      summary.state !== this.snapshot.summary?.state ||
      summary.collateral_state !== this.snapshot.summary?.collateral_state;
    this.update({
      summary,
      offer,
      funding: funding ?? undefined,
      screen,
      ...tokens,
      ...(advanced ? { error: undefined } : {}),
    });
    void this.readTransactions(client, id);
  }
  private async readTransactions(client: HedgeClient, id: string) {
    const current = this.snapshot.transactions;
    const needLock = this.snapshot.summary?.collateral_state !== "unlocked";
    const needSettlement =
      this.snapshot.summary?.state === "settling" ||
      this.snapshot.summary?.collateral_state === "settled";
    if (
      this.transactionReads.has(id) ||
      (current?.accept &&
        (!needLock || current.collateral) &&
        (!needSettlement || current.repayment))
    )
      return;
    this.transactionReads.add(id);
    try {
      const activity = await client.credit(id).activity();
      if (this.client !== client || this.snapshot.creditId !== id || !this.snapshot.open) return;
      const transactions: LoanTransactions = { ...this.snapshot.transactions };
      for (const event of activity) {
        const kind =
          event.stage === "LoanAccepted"
            ? "accept"
            : event.stage === "CollateralLocked"
              ? "collateral"
              : event.stage === "CollateralRepaymentRequested"
                ? "repaymentRequest"
                : event.stage === "CollateralSettled"
                  ? "settlement"
                  : event.stage === "CollateralRepaid"
                    ? "repayment"
                    : undefined;
        const transaction = transactionSchema.safeParse(event.transaction);
        if (
          kind &&
          transaction.success &&
          transaction.data.chain ===
            (["collateral", "settlement"].includes(kind) ? "base" : "hedera")
        )
          transactions[kind] = transaction.data;
      }
      this.update({ transactions });
    } catch {
      // Receipt links are optional; a history read must not block the loan's own progress.
    } finally {
      this.transactionReads.delete(id);
    }
  }
  renderer: ModalRenderer = (client, request) => {
    if (this.resolve || this.snapshot.busy)
      return Promise.reject(
        new HedgeError("MODAL_BUSY", "An existing loan operation is still in progress"),
      );
    this.client = client;
    this.requestedFunding = request.funding;
    const creditId = request.credit_id ?? this.knownLoans.get(client.manifest.instance_id);
    this.snapshot = initial();
    this.update({ open: true, request, creditId, screen: "connect" });
    const selection = new Promise<{ credit_id: string } | null>((resolve) => {
      this.resolve = resolve;
    });
    void this.run(async () => {
      await this.readWallets();
      if (creditId) {
        if (request.funding || request.amount !== undefined) {
          const current = await client.credit(creditId).summary();
          if (
            (current.state === "repaid" &&
              ["returned", "settled"].includes(current.collateral_state)) ||
            (current.state === "cancelled" &&
              ["returned", "unlocked"].includes(current.collateral_state))
          ) {
            this.knownLoans.delete(client.manifest.instance_id);
            this.update({ creditId: undefined });
            return;
          }
        }
        await this.readLoan();
        if (this.snapshot.screen === "funded") this.update({ screen: "manage" });
      }
    });
    return selection;
  };
  close = () => {
    this.update({ open: false });
    this.resolve?.(null);
    this.resolve = undefined;
  };
  connect = (chain: Chain) =>
    this.run(async () => {
      const wallet = this.validateWallet(chain, await this.services.connect(chain));
      this.update({ [chain]: wallet });
    });
  review = () =>
    this.run(async () => {
      await this.readWallets();
      this.assertWallets();
      if (this.snapshot.creditId) {
        await this.readLoan();
        this.assertWallets(this.snapshot.offer);
        return;
      }
      const request = this.snapshot.request;
      if (request?.amount !== undefined && !this.requestedFunding) {
        const ids = (await this.services.outstandingLoans?.(this.snapshot.hedera!.address)) ?? [];
        if (ids.length > 1)
          throw new HedgeError(
            "LOAN_SELECTION_REQUIRED",
            `Several loans need attention. Open a specific loan ID: ${ids.join(", ")}`,
          );
        if (ids.length === 1) {
          this.remember({
            instance_id: this.requireClient().manifest.instance_id,
            credit_id: ids[0],
          });
          await this.readLoan();
          this.assertWallets(this.snapshot.offer);
          return;
        }
        if (!this.services.loanToken)
          throw new HedgeError("TOKEN_UNAVAILABLE", "The adapter must read the lending asset");
        const metadata = await this.services.loanToken();
        const token = this.validateToken("hedera", metadata.address, metadata);
        this.requestedFunding = fundingRequestSchema.parse({
          token: token.address,
          amount: parseAmount(request.amount, token.decimals),
          recipient: {
            address: this.snapshot.hedera!.address,
            account_id: this.snapshot.hedera!.account_id,
          },
        });
      }
      const funding = this.requestedFunding;
      if (!funding) throw new HedgeError("INVALID_REQUEST", "Select a loan or funding request");
      const offers = (await this.requireClient().intent({ funding }).offers())
        .map((value) => this.validateOffer(value))
        .filter(
          (offer) =>
            offer.funding.amount === funding.amount &&
            sameAddress(offer.funding.token, funding.token) &&
            sameAddress(offer.collateral.owner, this.snapshot.base!.address) &&
            sameAddress(offer.funding.recipient.address, this.snapshot.hedera!.address) &&
            offer.funding.recipient.account_id === this.snapshot.hedera!.account_id,
        );
      if (!offers.length)
        throw new HedgeError("OFFER_UNAVAILABLE", "No funded offer is available for these wallets");
      const tokens = await this.tokens(offers[0]);
      this.update({ offers, offer: offers[0], ...tokens, screen: "review" });
    });
  selectOffer = (id: string) =>
    this.run(async () => {
      const offer = this.snapshot.offers.find((value) => value.id === id);
      if (!offer) throw new HedgeError("OFFER_UNAVAILABLE", "Select an available offer");
      const tokens = await this.tokens(offer);
      this.update({ offer, ...tokens });
    });
  accept = () =>
    this.run(async () => {
      if (this.snapshot.creditId)
        throw new HedgeError(
          "CREDIT_EXISTS",
          "Resume the existing loan instead of accepting again",
        );
      const { offer } = this.snapshot;
      const funding = this.requestedFunding;
      if (!offer || !funding)
        throw new HedgeError("OFFER_UNAVAILABLE", "Review a funded offer first");
      await this.readWallets();
      this.assertWallets(offer);
      const intent = this.requireClient().intent({ funding });
      const fresh = (await intent.offers()).find((value) => value.id === offer.id);
      if (!fresh || fresh.terms_hash.toLowerCase() !== offer.terms_hash.toLowerCase()) {
        this.update({ offers: [], offer: undefined, screen: "connect" });
        throw new HedgeError(
          "OFFER_CHANGED",
          "The offer changed or is unavailable. Review a funded offer again.",
        );
      }
      this.update({ screen: "setup" });
      const credit = await intent.accept({
        offer_id: offer.id,
        reviewedOffer: offer,
        on_progress: this.checkpoint,
      });
      this.knownLoans.set(this.requireClient().manifest.instance_id, credit.id);
      this.update({ creditId: credit.id });
      this.checkpoint({
        instance_id: this.requireClient().manifest.instance_id,
        credit_id: credit.id,
        stage: "funding_read",
      });
      await this.readLoan();
    });
  // Pending refresh keeps the operation gate and never submits transactions.
  refresh = async () => {
    if (!this.snapshot.open || !this.snapshot.creditId || this.refreshing) return;
    const client = this.client,
      id = this.snapshot.creditId;
    this.refreshing = true;
    try {
      await this.readLoan();
    } catch (error) {
      if (this.client === client && this.snapshot.creditId === id)
        this.update({
          error: errorMessage(error),
        });
    } finally {
      this.refreshing = false;
    }
  };
  resume = () =>
    this.run(async () => {
      await this.walletFor("hedera");
      await this.walletFor("base");
      await this.readLoan();
      this.assertWallets(this.snapshot.offer);
      if (!["accepted", "settling"].includes(this.snapshot.summary?.state ?? "")) return;
      await this.requireClient()
        .credit(this.snapshot.creditId!)
        .resume({ on_progress: this.checkpoint });
      await this.readLoan();
    });
  cancel = () =>
    this.run(async () => {
      await this.walletFor("hedera");
      await this.readLoan();
      if (this.snapshot.offer) this.assertBorrower(this.snapshot.offer);
      if (this.snapshot.summary?.state !== "accepted")
        throw new HedgeError(
          "CANCEL_UNAVAILABLE",
          "Only an eligible loan before payout can be cancelled",
        );
      await this.requireClient()
        .credit(this.snapshot.creditId!)
        .cancel({ on_progress: this.checkpoint });
      await this.readLoan();
    });
  manage = () => {
    if (!this.snapshot.busy && this.snapshot.summary?.state === "funded")
      this.update({ screen: "manage" });
  };
  prepareRepayment = () => {
    if (!this.snapshot.busy && this.snapshot.summary?.state === "funded")
      this.update({ screen: "repay" });
  };
  back = () => {
    if (!this.snapshot.busy) this.update({ screen: this.snapshot.creditId ? "manage" : "connect" });
  };
  selectRepaymentSource = (source: "wallet" | "collateral") => {
    if (
      !this.snapshot.busy &&
      this.snapshot.screen === "repay" &&
      (source === "wallet" || (this.snapshot.offer?.collateral.repayment_amount ?? 0n) > 0n)
    )
      this.update({ repaymentSource: source });
  };
  repay = () =>
    this.run(async () => {
      const reviewedDue = this.snapshot.summary?.amount_due;
      await this.walletFor("hedera");
      await this.readLoan();
      if (this.snapshot.offer) this.assertBorrower(this.snapshot.offer);
      if (
        this.snapshot.summary?.state !== "funded" ||
        reviewedDue !== this.snapshot.summary.amount_due
      )
        throw new HedgeError(
          "REPAYMENT_CHANGED",
          "Refresh and review the current amount due before repaying",
        );
      const credit = this.requireClient().credit(this.snapshot.creditId!);
      if (this.snapshot.repaymentSource === "collateral") {
        await this.walletFor("base");
        this.assertWallets(this.snapshot.offer);
        await credit.repayWithCollateral(this.snapshot.summary.agreement_hash, {
          on_progress: this.checkpoint,
        });
      } else {
        await credit.repay({ amount: "max", from: "wallet" }, { on_progress: this.checkpoint });
      }
      await this.readLoan();
    });
  claim = () =>
    this.run(async () => {
      const wallet = await this.walletFor("base");
      await this.readLoan();
      const offer = this.snapshot.offer;
      if (
        !offer ||
        (!sameAddress(wallet.address, offer.collateral.owner) &&
          !sameAddress(wallet.address, offer.collateral.return_recipient))
      )
        throw new HedgeError(
          "WALLET_MISMATCH",
          "Connect the Base owner or agreed return recipient",
        );
      if (
        !this.snapshot.summary ||
        !["repaid", "cancelled"].includes(this.snapshot.summary.state) ||
        this.snapshot.summary.collateral_state !== "return_authorized"
      )
        throw new HedgeError("RETURN_PENDING", "Wait for Base to authorize the collateral return");
      await this.requireClient()
        .credit(this.snapshot.creditId!)
        .collateral.claim({ on_progress: this.checkpoint });
      await this.readLoan();
    });
  continueToApp = () =>
    this.run(async () => {
      await this.readLoan();
      if (
        this.snapshot.summary?.state !== "funded" ||
        !this.snapshot.funding ||
        !this.snapshot.creditId
      )
        throw new HedgeError(
          "FUNDING_PENDING",
          "Wait for confirmed loan funding before continuing",
        );
      await this.walletFor("hedera");
      this.assertBorrower(this.snapshot.offer!);
      const resolve = this.resolve;
      this.resolve = undefined;
      this.update({ open: false });
      resolve?.({ credit_id: this.snapshot.creditId });
    });
}

/** Reuse the SDK adapter's wallets, verified reader and public checkpoint journal. */
export const createHedgeModal = (adapter: EvmHedgeAdapter) =>
  new HedgeModalController({
    connect: (chain) => adapter.options.wallet.connect(chain),
    wallet: (chain) => adapter.options.wallet.wallet(chain),
    token: (chain, address) => adapter.reader.token(chain, address),
    agreement: (id) => adapter.reader.agreement(id),
    loanToken: () => adapter.loanToken(),
    outstandingLoans: (borrower) => adapter.outstandingLoans(borrower),
    onCheckpoint: (checkpoint) => adapter.options.journal.checkpoint?.(checkpoint),
  });
