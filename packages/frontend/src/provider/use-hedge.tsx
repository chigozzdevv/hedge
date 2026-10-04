"use client";
import { useContext, useId, useSyncExternalStore, type ReactNode } from "react";
import { HedgeContext } from "./hedge-provider";
import type { HedgeAction } from "./hedge-runtime";
import { isLoanComplete } from "../modal/loan-state";
import "../modal/modal.css";

export interface UseHedgeProps extends HedgeAction {
  disabled?: boolean;
  className?: string;
  children?: ReactNode;
}
/** Connect, review and manage one loan; Continue refreshes the app after confirmed funding. */
export function UseHedge({ disabled, className, children, ...action }: UseHedgeProps) {
  const runtime = useContext(HedgeContext);
  if (!runtime) throw new Error("Mount HedgeProvider above UseHedge");
  const state = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot);
  const errorId = useId();
  const summary = state.session?.modal.getSnapshot().summary;
  const outstanding = summary && !isLoanComplete(summary);
  return (
    <span className="hedge-launch">
      <button
        type="button"
        className={`hedge-launch-button${className ? ` ${className}` : ""}`}
        disabled={disabled || state.busy}
        aria-describedby={state.error ? errorId : undefined}
        onClick={() => {
          void runtime.continue(action).catch(() => undefined);
        }}
      >
        {state.busy ? "Please wait…" : (children ?? (outstanding ? "Manage loan" : "Use Hedge"))}
      </button>
      {state.error && (
        <span id={errorId} className="hedge-launch-error" role="alert">
          {state.error.message}
        </span>
      )}
    </span>
  );
}
