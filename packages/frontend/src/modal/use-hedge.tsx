"use client";
import "./modal.css";
import { useEffect, useId, useRef, useSyncExternalStore, type ReactNode } from "react";
import type { HedgeModalController } from "./modal-controller";
import type { Chain, ConfirmedTransaction } from "@hedge/sdk";
import type { ModalSnapshot } from "./modal-types";
import { formatAmount, formatDuration, shortAddress, tokenAmount } from "./format-amount";
import { TransactionLink } from "../shared/transaction-link";

export interface ModalActions {
  close(): void;
  connect(chain: Chain): void | Promise<void>;
  review(): void | Promise<void>;
  selectOffer(id: string): void | Promise<void>;
  accept(): void | Promise<void>;
  refresh(): void | Promise<void>;
  resume(): void | Promise<void>;
  cancel(): void | Promise<void>;
  manage(): void;
  prepareRepayment(): void;
  selectRepaymentSource(source: "wallet" | "collateral"): void;
  repay(): void | Promise<void>;
  claim(): void | Promise<void>;
  continueToApp(): void | Promise<void>;
  back(): void;
}
function Amount({ label, value, symbol }: { label: string; value: string; symbol: string }) {
  return (
    <div className="hedge-amount">
      <div className="hedge-amount-label">{label}</div>
      <div className="hedge-number">
        {value}
        <span>{symbol}</span>
      </div>
    </div>
  );
}
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="hedge-term">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
function Steps({
  steps,
  chainIds,
}: {
  steps: { name: string; note: string; done: boolean; transaction?: ConfirmedTransaction }[];
  chainIds?: Partial<Record<Chain, number>>;
}) {
  const active = steps.findIndex((step) => !step.done);
  return (
    <ol className="hedge-steps" aria-label="Loan progress">
      {steps.map((step, index) => (
        <li
          className="hedge-step"
          key={step.name}
          data-state={step.done ? "done" : index === active ? "active" : "pending"}
          aria-current={index === active ? "step" : undefined}
        >
          <span className="hedge-step-mark" aria-hidden="true">
            {step.done ? "✓" : index + 1}
          </span>
          <div>
            <div className="hedge-step-name">{step.name}</div>
            <div className="hedge-step-note">{step.note}</div>
            {step.transaction && (
              <div className="hedge-step-receipt">
                <TransactionLink
                  chainId={chainIds?.[step.transaction.chain]}
                  hash={step.transaction.hash}
                  label={step.name}
                />
              </div>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
export function HedgeModalDialog({
  model,
  actions,
}: {
  model: ModalSnapshot;
  actions: ModalActions;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const element = dialog.current;
    if (model.open && !element?.open) element?.showModal();
    else if (!model.open && element?.open) element.close();
  }, [model.open]);
  const { screen, offer, summary, loanToken, collateralToken, busy } = model;
  const chainIds = {
    hedera: loanToken?.chain_id ?? model.hedera?.chain_id,
    base: collateralToken?.chain_id ?? model.base?.chain_id,
  };
  const transactions = model.transactions;
  const hasTerms = !!offer && !!loanToken && !!collateralToken;
  const loanAmount = hasTerms ? tokenAmount(offer.funding.amount, loanToken) : "";
  const repayment = hasTerms ? tokenAmount(offer.repayment_amount, loanToken) : "";
  const collateralPayment = offer?.collateral.repayment_amount ?? 0n;
  const payCollateral = model.repaymentSource === "collateral" && collateralPayment > 0n;
  const remainingCollateral = offer ? offer.collateral.amount - collateralPayment : 0n;
  const settledCollateral = summary?.collateral_state === "settled";
  const collateral = hasTerms ? tokenAmount(offer.collateral.amount, collateralToken) : "";
  const due = hasTerms && summary ? tokenAmount(summary.amount_due, loanToken) : repayment;
  const continuation = model.request?.context?.continueLabel ?? "Continue in app";
  const readyTitle = /^Continue to /i.test(continuation)
    ? continuation.replace(/^Continue to /i, "Ready to ")
    : "Your wallet is funded";
  const released =
    summary?.collateral_state === "return_authorized" || summary?.collateral_state === "returned";
  const returned = summary?.collateral_state === "returned";
  const canBack = screen === "review" || screen === "repay";
  const stage = model.checkpoint?.stage ?? "";
  const confirmingCollateral =
    screen === "setup" &&
    (summary?.collateral_state === "locked" ||
      !!transactions?.collateral ||
      stage === "custody_pending");
  const approvalPending = busy && stage.includes("-collateral-");
  const lockPending = busy && stage.includes("-lock_");
  const collateralNote = confirmingCollateral
    ? "Confirmed on Base"
    : approvalPending
      ? stage.endsWith("_signature")
        ? `Approve ${collateral || "collateral"} in your wallet`
        : "Confirming token approval on Base"
      : lockPending
        ? stage.endsWith("_signature")
          ? "Confirm the collateral lock in your wallet"
          : "Confirming collateral lock on Base"
        : busy && stage === "agreement_pending"
          ? "Waiting for the agreement to reach Base"
          : "On Base";
  const expiredSetup =
    screen === "setup" &&
    summary?.state === "accepted" &&
    !!offer &&
    offer.setup_deadline <= Math.floor(Date.now() / 1000);
  let title = "Connect wallets",
    primary = "Continue";
  let action: () => void | Promise<void> = actions.review;
  let disabled = busy || !model.base || !model.hedera;
  if (screen === "review") {
    title = model.request?.context?.title ?? "Review your loan";
    primary = `Borrow ${loanAmount}`;
    action = actions.accept;
    disabled = busy || !hasTerms;
  }
  if (screen === "setup") {
    title = confirmingCollateral ? "Confirming collateral" : "Funding your wallet";
    primary = confirmingCollateral
      ? "Waiting for funding…"
      : busy
        ? stage.endsWith("_signature")
          ? "Confirm in your wallet…"
          : "Waiting for confirmation…"
        : "Lock collateral";
    action = actions.resume;
    disabled = busy || confirmingCollateral || !model.creditId;
    if (expiredSetup) {
      title = "Setup expired";
      primary = "Cancel loan";
      action = actions.cancel;
      disabled = busy;
    }
  }
  if (screen === "funded") {
    title = readyTitle;
    primary = continuation;
    action = actions.continueToApp;
    disabled = busy || !model.funding;
  }
  if (screen === "manage") {
    title = "Your loan";
    primary = `Repay ${due}`;
    action = actions.prepareRepayment;
    disabled = busy || !hasTerms;
  }
  if (screen === "repay") {
    title = "Repay your loan";
    primary = busy
      ? "Confirming repayment…"
      : payCollateral
        ? "Repay with collateral"
        : `Repay ${due}`;
    action = actions.repay;
    disabled = busy || !hasTerms;
  }
  if (screen === "settle") {
    title = "Repaying with collateral";
    const ready = summary?.collateral_state === "settlement_authorized";
    primary = busy
      ? "Confirming repayment…"
      : ready
        ? "Continue repayment"
        : "Waiting for confirmation…";
    action = actions.resume;
    disabled = busy || !ready;
  }
  if (screen === "return") {
    title = released ? "Claim your collateral" : "Collateral release pending";
    primary = busy
      ? "Waiting for confirmation…"
      : released
        ? `Claim ${collateral} on Base`
        : "Waiting for release…";
    action = actions.claim;
    disabled = busy || !released || !hasTerms;
  }
  if (screen === "complete") {
    title = "All settled";
    primary = "Done";
    action = actions.close;
    disabled = false;
  }
  if (screen === "cancelled") {
    title = "Loan cancelled";
    primary = "Done";
    action = actions.close;
    disabled = false;
  }
  if (screen === "defaulted") {
    title = "Loan defaulted";
    primary = "Done";
    action = actions.close;
    disabled = false;
  }
  if (model.error && model.creditId && !busy && !expiredSetup) {
    primary = "Retry";
    action =
      screen === "setup" || screen === "settle"
        ? actions.resume
        : screen === "funded"
          ? actions.continueToApp
          : screen === "repay"
            ? actions.repay
            : screen === "return" && released
              ? actions.claim
              : actions.refresh;
    disabled = false;
  }
  return (
    <dialog
      ref={dialog}
      className="hedge-modal"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        actions.close();
      }}
    >
      <header className="hedge-header">
        {canBack ? (
          <button className="hedge-back" type="button" onClick={actions.back} disabled={busy}>
            ← Back
          </button>
        ) : (
          <span className="hedge-brand">Use Hedge</span>
        )}
        <button
          className="hedge-close"
          type="button"
          onClick={actions.close}
          aria-label="Close modal"
        >
          ×
        </button>
      </header>
      <div className="hedge-body">
        <h2 className="hedge-title" id={titleId}>
          {title}
        </h2>
        {screen === "connect" && (
          <>
            <p className="hedge-subtitle">Base for collateral. Hedera for your loan.</p>
            <div className="hedge-wallets">
              {(["base", "hedera"] as const).map((chain) => (
                <div className="hedge-wallet" key={chain}>
                  <span className={`hedge-network hedge-${chain}`} aria-hidden="true">
                    {chain === "base" ? "−" : "ℏ"}
                  </span>
                  <div className="hedge-wallet-label">
                    <div>{chain === "base" ? "Base" : "Hedera"}</div>
                    <div className="hedge-wallet-note">
                      {model[chain]
                        ? (model[chain].account_id ?? shortAddress(model[chain].address))
                        : "Not connected"}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="hedge-connect"
                    data-connected={!!model[chain]}
                    disabled={busy}
                    onClick={() => void actions.connect(chain)}
                  >
                    {model[chain] ? "✓ Connected" : "Connect"}
                  </button>
                </div>
              ))}
            </div>
            <p className="hedge-note">
              {model.base && model.hedera
                ? "Both wallets connected."
                : "Connect both wallets to continue."}
            </p>
          </>
        )}
        {screen === "review" && hasTerms && (
          <>
            {model.request?.context?.description && (
              <p className="hedge-subtitle">{model.request.context.description}</p>
            )}
            {model.offers.length > 1 && (
              <label className="hedge-offers">
                Funded offer
                <select
                  value={offer.id}
                  disabled={busy}
                  onChange={(event) => void actions.selectOffer(event.target.value)}
                >
                  {model.offers.map((value) => (
                    <option value={value.id} key={value.id}>
                      {value.id}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <Amount
              label="You borrow"
              value={formatAmount(offer.funding.amount, loanToken.decimals)}
              symbol={loanToken.symbol}
            />
            <dl className="hedge-terms">
              <Row label="Collateral">{collateral}</Row>
              <Row label="Repayment">{repayment}</Row>
              <Row label="Term">{formatDuration(offer.duration)}</Row>
            </dl>
            <p className="hedge-note">If you default, the operator receives your full pledge.</p>
            <details className="hedge-details">
              <summary>Costs and terms</summary>
              <p>
                The financing fee is{" "}
                {tokenAmount(offer.repayment_amount - offer.funding.amount, loanToken)}. Repay{" "}
                {repayment} in full, including for early repayment. Network fees are separate. After
                repayment, claim your {collateral} collateral on Base.
              </p>
              <dl className="hedge-terms">
                <Row label="Receive in">{offer.funding.recipient.account_id}</Row>
                <Row label="Return to">{shortAddress(offer.collateral.return_recipient)}</Row>
                <Row label="Accept by">
                  {new Date(offer.acceptance_deadline * 1000).toLocaleString()}
                </Row>
                <Row label="Set up by">
                  {new Date(offer.setup_deadline * 1000).toLocaleString()}
                </Row>
                {offer.grace_period > 0 && (
                  <Row label="Grace period">{formatDuration(offer.grace_period)}</Row>
                )}
              </dl>
            </details>
          </>
        )}
        {screen === "setup" && !expiredSetup && (
          <>
            <p className="hedge-subtitle">
              {model.creditId
                ? confirmingCollateral
                  ? "Your collateral is locked on Base. Waiting for your Hedera payout."
                  : "Your wallets will prompt when a signature is needed."
                : "Confirm the loan in your Hedera wallet."}
            </p>
            <Steps
              chainIds={chainIds}
              steps={[
                {
                  name: "Accept loan",
                  note:
                    summary || transactions?.accept ? "Confirmed on Hedera" : "Confirmation needed",
                  done: !!summary || !!transactions?.accept,
                  transaction: transactions?.accept,
                },
                {
                  name: confirmingCollateral ? "Collateral locked" : "Lock collateral",
                  note: collateralNote,
                  done: confirmingCollateral,
                  transaction: transactions?.collateral,
                },
                {
                  name: model.funding ? "Funds received" : "Receive funds",
                  note: model.funding ? `${loanAmount} received` : "Waiting for confirmed payout",
                  done: !!model.funding,
                  transaction: model.funding?.transaction,
                },
              ]}
            />
            {model.creditId && (
              <p className="hedge-note">You can close this and resume the same loan.</p>
            )}
          </>
        )}
        {expiredSetup && (
          <p className="hedge-subtitle">
            The setup window has ended. Cancel this unfunded loan to return any pledged collateral.
          </p>
        )}
        {screen === "funded" && hasTerms && (
          <>
            <p className="hedge-subtitle">Your {loanToken.symbol} is in your Hedera wallet.</p>
            <Amount
              label="Received"
              value={formatAmount(offer.funding.amount, loanToken.decimals)}
              symbol={loanToken.symbol}
            />
            <dl className="hedge-terms">
              <Row label="Repayment">{repayment}</Row>
              <Row label="Collateral">{collateral}</Row>
            </dl>
            <p className="hedge-success">✓ Loan payout confirmed</p>
          </>
        )}
        {screen === "manage" && hasTerms && summary && (
          <>
            <Amount
              label="Amount due"
              value={formatAmount(summary.amount_due, loanToken.decimals)}
              symbol={loanToken.symbol}
            />
            <dl className="hedge-terms">
              <Row label="Received">{loanAmount}</Row>
              <Row label="Collateral on Base">{collateral}</Row>
              <Row label="Term">{formatDuration(offer.duration)}</Row>
              {summary.payment_deadline && (
                <Row label="Repay by">
                  {new Date(summary.payment_deadline * 1000).toLocaleString()}
                </Row>
              )}
            </dl>
            <p className="hedge-note">
              {collateralPayment > 0n
                ? "Repay from your Hedera wallet or use your Base collateral."
                : "Repay in full on Hedera, then claim your collateral on Base."}
            </p>
          </>
        )}
        {screen === "repay" && hasTerms && summary && (
          <>
            {collateralPayment > 0n && (
              <div className="hedge-repayment-source" role="group" aria-label="Repayment method">
                <button
                  type="button"
                  aria-pressed={!payCollateral}
                  disabled={busy}
                  onClick={() => actions.selectRepaymentSource("wallet")}
                >
                  Wallet
                </button>
                <button
                  type="button"
                  aria-pressed={payCollateral}
                  disabled={busy}
                  onClick={() => actions.selectRepaymentSource("collateral")}
                >
                  Collateral
                </button>
              </div>
            )}
            <p className="hedge-subtitle">
              {payCollateral
                ? "Use the collateral already locked on Base."
                : "Confirm payment in your Hedera wallet."}
            </p>
            <Amount
              label="Full repayment"
              value={formatAmount(
                payCollateral ? collateralPayment : summary.amount_due,
                payCollateral ? collateralToken.decimals : loanToken.decimals,
              )}
              symbol={payCollateral ? collateralToken.symbol : loanToken.symbol}
            />
            <dl className="hedge-terms">
              <Row label="Pay from">
                {payCollateral
                  ? "Locked collateral · Base"
                  : `Hedera · ${offer.funding.recipient.account_id}`}
              </Row>
              {payCollateral && (
                <Row label="Operator receives">
                  {tokenAmount(collateralPayment, collateralToken)} ·{" "}
                  {shortAddress(offer.collateral.recovery_recipient)}
                </Row>
              )}
              <Row label="Collateral to return">
                {payCollateral ? tokenAmount(remainingCollateral, collateralToken) : collateral}
              </Row>
            </dl>
            <p className="hedge-payment-note">
              {payCollateral
                ? "Confirm on Hedera, then Base. The agreed repayment goes to the operator and the remainder returns to your Base wallet. Network fees are separate."
                : `You may first need to approve ${loanToken.symbol}. Your collateral stays locked until Base receives the release. Early repayment has the same financing fee.`}
            </p>
          </>
        )}
        {screen === "settle" && hasTerms && (
          <>
            <Steps
              chainIds={chainIds}
              steps={[
                {
                  name: "Authorize repayment",
                  note: "Confirmed on Hedera",
                  done: true,
                  transaction: transactions?.repaymentRequest,
                },
                {
                  name: "Settle on Base",
                  note: settledCollateral
                    ? "Operator paid; remainder returned"
                    : summary?.collateral_state === "settlement_authorized"
                      ? "Confirm in your Base wallet"
                      : "Waiting for authorization",
                  done: settledCollateral,
                  transaction: transactions?.settlement,
                },
                {
                  name: "Confirm repayment",
                  note: "Waiting for the Base receipt on Hedera",
                  done: summary?.state === "repaid",
                  transaction: transactions?.repayment,
                },
              ]}
            />
            <p className="hedge-note">You can close this and resume the same repayment.</p>
          </>
        )}
        {screen === "return" && (
          <>
            <p className="hedge-subtitle">
              {summary?.state === "cancelled" ? "Your loan is cancelled." : "Your loan is repaid."}{" "}
              {released
                ? `Return ${collateral} to your Base wallet.`
                : "Waiting for the release to reach Base."}
            </p>
            <Steps
              steps={[
                {
                  name: summary?.state === "cancelled" ? "Cancel loan" : "Repay loan",
                  note:
                    summary?.state === "cancelled"
                      ? "Confirmed on Hedera"
                      : `${repayment} paid on Hedera`,
                  done: summary?.state === "repaid" || summary?.state === "cancelled",
                },
                {
                  name: "Release collateral",
                  note: released ? "Return authorized on Base" : "Waiting for Base confirmation",
                  done: released,
                },
                {
                  name: "Claim on Base",
                  note: `${collateral} to ${offer ? shortAddress(offer.collateral.return_recipient) : "your agreed wallet"}`,
                  done: returned,
                },
              ]}
            />
            <p className="hedge-note">You can close this and come back to claim.</p>
          </>
        )}
        {screen === "complete" && hasTerms && (
          <>
            <p className="hedge-subtitle">
              {settledCollateral
                ? "Your loan is repaid and the collateral settlement is complete."
                : "Your collateral is back in your agreed Base wallet."}
            </p>
            <Amount
              label="Collateral returned"
              value={formatAmount(
                settledCollateral ? remainingCollateral : offer.collateral.amount,
                collateralToken.decimals,
              )}
              symbol={collateralToken.symbol}
            />
            <dl className="hedge-terms">
              <Row
                label={
                  summary?.state === "cancelled"
                    ? "Loan"
                    : settledCollateral
                      ? "Repaid with Base collateral"
                      : "Repaid on Hedera"
                }
              >
                {summary?.state === "cancelled"
                  ? "Cancelled before funding"
                  : settledCollateral
                    ? tokenAmount(collateralPayment, collateralToken)
                    : repayment}
              </Row>
              <Row label="Returned to">
                Base · {shortAddress(offer.collateral.return_recipient)}
              </Row>
            </dl>
            <p className="hedge-success">
              {settledCollateral ? "✓ Loan repaid with collateral" : "✓ Collateral claimed"}
            </p>
          </>
        )}
        {screen === "cancelled" && (
          <p className="hedge-subtitle">
            No loan was paid out and no collateral is awaiting return.
          </p>
        )}
        {screen === "defaulted" && (
          <>
            <p className="hedge-subtitle">
              Hedera has finalized default. The agreed pledge is reserved for the operator's
              recovery recipient.
            </p>
            <p className="hedge-note">
              {summary?.collateral_state === "recovered"
                ? "The pledge has been claimed on Base."
                : summary?.collateral_state === "recovery_authorized"
                  ? "Recovery is authorized on Base."
                  : "Waiting for the recovery outcome to reach Base."}
            </p>
          </>
        )}
        {model.creditId && (
          <details className="hedge-details">
            <summary>Loan details</summary>
            <dl className="hedge-terms">
              <Row label="Loan ID">
                <code>{model.creditId}</code>
              </Row>
              {(
                [
                  ["Accept loan", transactions?.accept],
                  ["Lock collateral", transactions?.collateral],
                  ["Receive funds", model.funding?.transaction],
                  ["Authorize collateral repayment", transactions?.repaymentRequest],
                  ["Settle on Base", transactions?.settlement],
                  ["Confirm repayment", transactions?.repayment],
                ] as const
              ).map(
                ([label, transaction]) =>
                  transaction && (
                    <Row key={label} label={label}>
                      <TransactionLink
                        chainId={chainIds[transaction.chain]}
                        hash={transaction.hash}
                        label={label}
                      />
                    </Row>
                  ),
              )}
            </dl>
          </details>
        )}
        {model.error && (
          <p className="hedge-error" role="alert">
            {model.error}
          </p>
        )}
        {model.error && summary?.state === "accepted" && !expiredSetup && (
          <details className="hedge-details">
            <summary>Recovery options</summary>
            <p>Cancel this unfunded loan and return any pledged collateral.</p>
            <button
              type="button"
              className="hedge-secondary"
              disabled={busy}
              onClick={() => void actions.cancel()}
            >
              Cancel loan
            </button>
          </details>
        )}
      </div>
      <footer className="hedge-footer">
        <button
          type="button"
          className="hedge-primary"
          disabled={disabled}
          onClick={() => void action()}
        >
          {busy && screen === "connect" ? "Connecting…" : primary}
        </button>
      </footer>
    </dialog>
  );
}
export function UseHedgeModal({ controller }: { controller: HedgeModalController }) {
  const model = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  useEffect(() => {
    if (!model.open || !model.creditId) return;
    const timer = setInterval(() => {
      void controller.refresh();
    }, 5000);
    return () => clearInterval(timer);
  }, [controller, model.open, model.creditId]);
  useEffect(() => () => controller.close(), [controller]);
  return <HedgeModalDialog model={model} actions={controller} />;
}
