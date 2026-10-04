"use client";
import { useEffect, useId, useState, useSyncExternalStore, type ReactNode } from "react";
import "./swap.css";
import { UseHedge, TransactionLink } from "@hedge/frontend";
import { formatAmount } from "@hedge/sdk";
import { SwapController } from "./swap-controller";
import type { SwapServices } from "./swap-types";

/** Keep swap services stable for the lifetime of the mounted form. */
export function SwapForm({
  services,
  loanSummary,
}: {
  services: SwapServices;
  loanSummary?: ReactNode;
}) {
  const [controller] = useState(() => new SwapController(services));
  const model = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const [now, setNow] = useState(0);
  const amountId = useId();
  useEffect(() => {
    void controller.initialize();
  }, [controller]);
  useEffect(() => {
    if (!model.quote && !model.estimate) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [model.quote, model.estimate]);
  const sell = controller.assets.find((asset) => asset.id === model.sell)!;
  const buy = controller.assets.find((asset) => asset.id === model.buy)!;
  const buyToken = controller.token(model.buy);
  const sellToken = controller.token(model.sell);
  const quote = model.quote;
  const expired = !!quote && quote.expires_at <= now;
  const insufficient = !!quote && model.balance !== undefined && model.balance < quote.sell_amount;
  const locked = model.busy || !!model.transactionId;
  const estimate = model.estimate && model.estimate.expires_at > now ? model.estimate : undefined;
  const buyAmount = model.receipt?.buy_amount ?? quote?.buy_amount ?? estimate?.buy_amount;
  useEffect(() => {
    if (locked || quote) return;
    const update = () => void controller.preview();
    const timer = setTimeout(update, 300);
    const refresh = setInterval(update, 30_000);
    return () => {
      clearTimeout(timer);
      clearInterval(refresh);
    };
  }, [controller, model.amount, model.sell, model.buy, locked, quote]);
  const balance = controller.balanceLabel();
  const shortfall = controller.shortfall();
  let primary = model.wallet
    ? model.amount.trim()
      ? "Review swap"
      : "Enter amount"
    : "Connect wallet";
  if (quote)
    primary = expired
      ? "Refresh quote"
      : insufficient
        ? `Insufficient ${sell.symbol}`
        : "Confirm swap";
  if (model.transactionId) primary = "Check swap";
  if (model.busy) primary = model.transactionId ? "Confirming…" : "Please wait…";
  if (model.receipt) primary = "New swap";
  const primaryDisabled =
    model.busy ||
    (!!model.wallet && !model.amount.trim()) ||
    (insufficient && !expired && !model.transactionId);

  return (
    <>
      <section className="hedge-swap swap-card" aria-labelledby="swap-title">
        <header className="swap-header">
          <h1 id="swap-title">Swap</h1>
          <button
            className="swap-wallet"
            type="button"
            disabled={locked}
            onClick={() => void controller.connect()}
          >
            {model.wallet
              ? (model.wallet.account_id ??
                `${model.wallet.address.slice(0, 6)}…${model.wallet.address.slice(-4)}`)
              : "Connect wallet"}
          </button>
        </header>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (model.receipt) controller.reset();
            else if (!model.wallet) void controller.connect();
            else if (model.transactionId || (quote && !expired)) void controller.confirm();
            else void controller.review();
          }}
        >
          {quote && !model.transactionId && (
            <div className="swap-review-heading">
              <button type="button" onClick={controller.back} disabled={model.busy}>
                ← Back
              </button>
              <span>Review swap</span>
            </div>
          )}
          <div className="swap-field">
            <div className="swap-field-heading">
              <label htmlFor={amountId}>You pay</label>
              {balance !== undefined && <span>Balance: {balance}</span>}
            </div>
            <div className="swap-field-row">
              <input
                id={amountId}
                aria-label="Amount to swap"
                inputMode="decimal"
                autoComplete="off"
                placeholder="0"
                value={model.amount}
                disabled={locked || !!quote}
                onChange={(event) => controller.setAmount(event.target.value)}
              />
              <TokenLabel label="Pay token" symbol={sell.symbol} />
            </div>
          </div>
          <div className="swap-direction">
            <span aria-hidden="true">↓</span>
          </div>
          <div className="swap-field">
            <div className="swap-field-heading">
              <span>{model.receipt ? "You received" : "You receive"}</span>
              <span role="status">
                {model.estimating
                  ? "Quoting…"
                  : buyAmount !== undefined && !model.receipt
                    ? "Estimated"
                    : ""}
              </span>
            </div>
            <div className="swap-field-row">
              <output aria-label="Amount to receive" aria-live="polite">
                {buyToken && buyAmount !== undefined && !model.estimating
                  ? formatAmount(buyAmount, buyToken.decimals)
                  : "—"}
              </output>
              <TokenLabel label="Receive token" symbol={buy.symbol} />
            </div>
            {model.estimateError && !quote && (
              <p className="swap-estimate-error" role="alert">
                {model.estimateError}
              </p>
            )}
          </div>
          {quote && buyToken && (
            <dl className="swap-details">
              <div>
                <dt>Minimum received</dt>
                <dd>
                  {formatAmount(quote.minimum_received, buyToken.decimals)} {buy.symbol}
                </dd>
              </div>
              <div>
                <dt>Slippage</dt>
                <dd>{quote.slippage_bps / 100}%</dd>
              </div>
              <div>
                <dt>Network fee</dt>
                <dd>
                  {formatAmount(quote.network_fee.amount, quote.network_fee.decimals)}{" "}
                  {quote.network_fee.symbol}
                </dd>
              </div>
            </dl>
          )}
          {model.transactionId && (
            <p className="swap-status" role="status">
              {model.receipt ? "Swap complete" : "Swap submitted. Awaiting confirmation."}
              <TransactionLink
                chainId={quote?.chain_id ?? sellToken?.chain_id}
                hash={model.transactionId}
                label="Swap"
              />
            </p>
          )}
          {model.error && (
            <p className="swap-error" role="alert">
              {model.error}
            </p>
          )}
          <button className="swap-primary" disabled={primaryDisabled} type="submit">
            {primary}
          </button>
        </form>
        <footer className="swap-footer">
          {model.sell === "usdc" && (
            <UseHedge
              className="swap-hedge-button"
              amount={shortfall ?? "0"}
              continueLabel="Continue to swap"
              onContinue={controller.afterFunding}
              disabled={model.busy || (!!model.transactionId && !model.receipt)}
            />
          )}
        </footer>
        {loanSummary}
      </section>
    </>
  );
}
function TokenLabel({ label, symbol }: { label: string; symbol: string }) {
  return (
    <div className="swap-token" role="group" aria-label={label}>
      <span className="swap-token-mark" data-symbol={symbol} aria-hidden="true">
        {symbol === "HBAR" ? "ℏ" : symbol === "USDC" ? "$" : symbol[0]}
      </span>
      <span className="swap-token-symbol">{symbol}</span>
      <details className="swap-token-info">
        <summary aria-label={`${label}: more tokens`}>i</summary>
        <span role="status">More tokens coming soon</span>
      </details>
    </div>
  );
}
