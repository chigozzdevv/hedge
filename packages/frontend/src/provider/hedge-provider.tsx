"use client";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { UseHedgeModal } from "../modal/use-hedge";
import type { HedgeSetup } from "./hedge-session";
import { HedgeRuntime } from "./hedge-runtime";

export const HedgeContext = createContext<HedgeRuntime | undefined>(undefined);
export interface HedgeProviderProps extends HedgeSetup {
  children: ReactNode;
}

/** Mount once. Host children render immediately; Hedge initializes on demand. */
export function HedgeProvider({ wallet, config, request, children }: HedgeProviderProps) {
  const runtime = useMemo(
    () => new HedgeRuntime({ wallet, config, request }),
    [wallet, config, request],
  );
  const state = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot);
  useEffect(() => {
    runtime.activate();
    return runtime.deactivate;
  }, [runtime]);
  return (
    <HedgeContext.Provider value={runtime}>
      {children}
      {state.session && <UseHedgeModal controller={state.session.modal} />}
    </HedgeContext.Provider>
  );
}

/** Advanced access: open the same modal, or await ready() for SDK resource handles. */
export function useHedge() {
  const runtime = useContext(HedgeContext);
  if (!runtime) throw new Error("Mount HedgeProvider above useHedge");
  return useMemo(() => ({ open: runtime.open, ready: runtime.ready }), [runtime]);
}
