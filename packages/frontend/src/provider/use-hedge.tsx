"use client";
import { useContext, useEffect, useId, useSyncExternalStore, type ReactNode } from "react";
import { decimalAmountSchema } from "@hedge/schema";
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
  useEffect(() => {
    void runtime.restore().catch(() => undefined);
  }, [runtime]);
  const errorId = useId();
  const model = state.session?.modal.getSnapshot();
  const outstanding = model?.creditId && (!model.summary || !isLoanComplete(model.summary));
  const validAmount =
    typeof action.amount === "function" ||
    (decimalAmountSchema.safeParse(action.amount).success && /[1-9]/.test(action.amount as string));
  return (
    <span className="hedge-launch">
      <button
        type="button"
        className={`hedge-launch-button${className ? ` ${className}` : ""}`}
        disabled={disabled || state.busy || (!outstanding && !validAmount)}
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
