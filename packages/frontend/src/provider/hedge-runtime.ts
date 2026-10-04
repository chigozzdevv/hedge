import { HedgeError, type FundingResult, type OpenOptions, type LoanAmount } from "@hedge/sdk";
import { setupHedge, type HedgeSetup, type HedgeSession } from "./hedge-session";
import { isLoanComplete } from "../modal/loan-state";

export interface HedgeState {
  session?: HedgeSession;
  busy: boolean;
  error?: Error;
}
export type HedgeAction = {
  amount?: LoanAmount;
  continueLabel?: string;
  onContinue?: (funding: FundingResult) => void | Promise<void>;
};

/** One lazy client and one operation gate per provider, including the host continuation. */
export class HedgeRuntime {
  private state: HedgeState = { busy: false };
  private listeners = new Set<() => void>();
  private pending?: Promise<HedgeSession>;
  private abort?: AbortController;
  private unsubscribe?: () => void;
  private unsubscribeWallet?: () => void;
  private recovering?: Promise<void>;
  private active = true;
  private generation = 0;
  private operating = false;
  constructor(
    private readonly options: HedgeSetup,
    private readonly setup = setupHedge,
  ) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(values: Partial<HedgeState>) {
    this.state = {
      ...this.state,
      ...values,
      busy: this.operating || !!(values.session ?? this.state.session)?.modal.getSnapshot().busy,
    };
    this.listeners.forEach((listener) => listener());
  }
  activate = () => {
    this.active = true;
  };
  deactivate = () => {
    this.active = false;
    this.generation++;
    this.abort?.abort();
    this.state.session?.modal.close();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.unsubscribeWallet?.();
    this.unsubscribeWallet = undefined;
    this.pending = undefined;
    this.recovering = undefined;
    this.state = { busy: this.operating };
  };
  ready = async (): Promise<HedgeSession["client"]> => (await this.session()).client;
  private async session(): Promise<HedgeSession> {
    if (!this.active)
      throw new HedgeError("PROVIDER_CLOSED", "Hedge provider is no longer mounted");
    if (this.state.session) return this.state.session;
    if (this.pending) return this.pending;
    const generation = this.generation;
    const abort = new AbortController();
    this.abort = abort;
    const pending = this.setup(this.options, abort.signal)
      .then((session) => {
        if (!this.active || generation !== this.generation) {
          session.modal.close();
          throw new HedgeError("PROVIDER_CLOSED", "Hedge provider is no longer mounted");
        }
        this.unsubscribe = session.modal.subscribe(() => this.update({}));
        this.unsubscribeWallet = session.adapter.options.wallet.subscribe?.(() => {
          void this.restore().catch(() => undefined);
        });
        this.update({ session, error: undefined });
        return session;
      })
      .finally(() => {
        if (this.pending === pending) this.pending = undefined;
      });
    this.pending = pending;
    return pending;
  }
  restore = (): Promise<void> => {
    if (this.operating) return Promise.resolve();
    if (this.recovering) return this.recovering;
    const generation = this.generation;
    const pending = (async () => {
      try {
        const session = await this.session();
        let id = session.modal.getSnapshot().creditId;
        if (!id) {
          const wallet = await session.adapter.options.wallet.wallet("hedera");
          if (!wallet) return;
          const ids = await session.adapter.outstandingLoans(wallet.address);
          if (ids.length > 1)
            throw new HedgeError(
              "LOAN_SELECTION_REQUIRED",
              "Open a specific loan ID to manage your outstanding loans",
            );
          id = ids[0];
        }
        if (!id) return;
        const summary = await session.client.credit(id).summary();
        if (!this.active || generation !== this.generation || this.operating) return;
        session.modal.remember({ instance_id: summary.instance_id, credit_id: id }, summary);
        if (isLoanComplete(summary)) session.modal.forgetCompleted(summary);
      } catch (error) {
        if (this.active && generation === this.generation && !this.operating)
          this.update({
            error: error instanceof Error ? error : new Error("Could not restore your loan"),
          });
        throw error;
      }
    })().finally(() => {
      if (this.recovering === pending) this.recovering = undefined;
    });
    this.recovering = pending;
    return pending;
  };
  private async exclusive(options: (session: HedgeSession) => Promise<OpenOptions | null>) {
    if (this.operating || this.state.session?.modal.getSnapshot().busy)
      throw new HedgeError("MODAL_BUSY", "An existing loan operation is still in progress");
    this.operating = true;
    const generation = this.generation;
    this.update({ error: undefined });
    try {
      const session = await this.session();
      const request = await options(session);
      if (!this.active || generation !== this.generation)
        throw new HedgeError("PROVIDER_CLOSED", "Hedge provider is no longer mounted");
      if (!request) return null;
      const result = await session.client.open({ ...request, onFunded: undefined });
      if (result && this.active && generation === this.generation) await request.onFunded?.(result);
      return result;
    } catch (error) {
      if (this.active && generation === this.generation)
        this.update({ error: error instanceof Error ? error : new Error("Could not open Hedge") });
      throw error;
    } finally {
      this.operating = false;
      if (this.active) {
        this.update({});
        if (generation === this.generation) void this.restore().catch(() => undefined);
      }
    }
  }
  /** Advanced access uses the same client, modal and operation gate. */
  open = (options: OpenOptions) => this.exclusive(async () => options);
  continue = ({ amount, continueLabel = "Continue", onContinue }: HedgeAction) =>
    this.exclusive(async (session) => {
      const saved = session.modal.getSnapshot().creditId;
      let resume = saved;
      if (saved) {
        const summary = await session.client.credit(saved).summary();
        if (isLoanComplete(summary)) {
          session.modal.forgetCompleted(summary);
          resume = undefined;
        }
      }
      if (!resume) {
        const wallet = await session.adapter.options.wallet.wallet("hedera");
        if (wallet) {
          const ids = await session.adapter.outstandingLoans(wallet.address);
          if (ids.length > 1)
            throw new HedgeError(
              "LOAN_SELECTION_REQUIRED",
              `Several loans need attention. Open a specific loan ID: ${ids.join(", ")}`,
            );
          resume = ids[0];
        }
      }
      const presentation = {
        context: { title: "Use Hedge", continueLabel },
        onFunded: onContinue,
      };
      if (resume) return { credit_id: resume, ...presentation };
      if (amount === undefined || (typeof amount === "string" && /^0+(?:\.0*)?$/.test(amount)))
        return null;
      return { amount, ...presentation };
    });
}
