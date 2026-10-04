"use client";
import { useEffect, useRef, useState } from "react";
import {
  HedgeError,
  EvmHedgeReader,
  createAccountResolver,
  type EvmWallet,
  type EvmTransaction,
} from "@hedge/sdk";
import { clientConfigSchema } from "@hedge/schema";
import { decodeFunctionData, formatUnits } from "viem";
import { hedgeLendingAbi } from "@hedge/bindings";
import { tokenAbi } from "@hedge/sdk";
import { HedgeProvider, type HedgeProviderProps } from "@hedge/frontend";
import { SwapForm } from "../swap/swap-form";
import { createSwapServices } from "./swap-service";
import { LoanSummary } from "./loan-summary";
import { RuntimeWallet, runtimeRequest, type RuntimeProfile } from "./wallet-service";

type Approval = { tx: EvmTransaction; fee: string; resolve: (approved: boolean) => void };
type HedgeSetup = Pick<HedgeProviderProps, "wallet" | "request" | "config">;
export function RuntimeApp() {
  const [profile, setProfile] = useState<RuntimeProfile>();
  const [setup, setSetup] = useState<{
    hedge: HedgeSetup;
    reader: EvmHedgeReader;
    wallet: EvmWallet;
  }>();
  const [error, setError] = useState<string>();
  const [mode] = useState<"injected" | "local">(() =>
    typeof window !== "undefined" &&
    ["127.0.0.1", "localhost"].includes(window.location.hostname) &&
    new URLSearchParams(window.location.search).get("test_wallet") === "1"
      ? "local"
      : "injected",
  );
  const [approval, setApproval] = useState<Approval>();
  useEffect(() => {
    let live = true;
    const legacy = new URLSearchParams(window.location.search).get("deployment") === "v2";
    void runtimeRequest<RuntimeProfile>(legacy ? "config?deployment=v2" : "config")
      .then((profile) => {
        clientConfigSchema.parse(profile.config);
        if (live) setProfile(profile);
      })
      .catch((error) => {
        if (live) setError(error instanceof Error ? error.message : "Hedge service is unavailable");
      });
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (!profile) return;
    const reader = new EvmHedgeReader({
      manifest: profile.config.deployment,
      rpc: profile.config.rpc,
      startBlock: {
        hedera: BigInt(profile.config.start_block.hedera),
        base: BigInt(profile.config.start_block.base),
      },
      resolveAccount: createAccountResolver(profile.config.mirror_url),
    });
    const wallet = new RuntimeWallet(profile, reader, mode, async (tx) => {
      const client = reader.clients[tx.chain];
      const [gas, price] = await Promise.all([
        client.estimateGas({
          account: profile.borrower.address as `0x${string}`,
          to: tx.to,
          data: tx.data,
          value: tx.value ?? 0n,
        }),
        client.getGasPrice(),
      ]);
      const fee = `${formatUnits((gas * price * 125n) / 100n, 18)} ${tx.chain === "hedera" ? "HBAR" : "ETH"}`;
      return new Promise((resolve) => setApproval({ tx, fee, resolve }));
    });
    setSetup({
      reader,
      wallet,
      hedge: {
        config: profile.config,
        wallet: (hedgeReader) => {
          if (hedgeReader.manifest.instance_id !== profile.config.deployment.instance_id)
            throw new HedgeError(
              "CONFIG_MISMATCH",
              "The app and local operator use different deployments",
            );
          return wallet;
        },
        // Authenticate only to the configured local operator, never the public config/RPC URL.
        request: (input, init) => {
          if (
            profile.config.deployment.protocol_version === 2 &&
            typeof input === "string" &&
            input.endsWith("/offers")
          )
            return Promise.reject(
              new Error("This page manages existing v2 loans. Open /demo for new borrowing."),
            );
          const headers = new Headers(init?.headers);
          if (typeof input === "string" && input.startsWith(`${profile.config.operator_url}/`))
            headers.set("x-hedge-session", profile.session);
          return fetch(input, { ...init, headers });
        },
      },
    });
  }, [profile, mode]);
  return (
    <>
      {setup && profile ? (
        <>
          <div className="runtime-network">Hedera testnet · Base Sepolia</div>
          <HedgeProvider {...setup.hedge}>
            <RuntimeSwap
              profile={profile}
              reader={setup.reader}
              wallet={setup.wallet}
              mode={mode}
            />
          </HedgeProvider>
        </>
      ) : (
        <SwapLoading error={error} />
      )}
      <WalletApproval
        approval={approval}
        finish={(accepted) => {
          approval?.resolve(accepted);
          setApproval(undefined);
        }}
      />
    </>
  );
}

function SwapLoading({ error }: { error?: string }) {
  return (
    <section className="hedge-swap swap-card" aria-busy={!error} aria-label="Swap">
      <header className="swap-header">
        <h1>Swap</h1>
      </header>
      {error ? (
        <p className="swap-error" role="alert">
          {error}
        </p>
      ) : (
        <span className="swap-loading" role="status" aria-label="Loading" />
      )}
    </section>
  );
}

function RuntimeSwap({
  profile,
  reader,
  wallet,
  mode,
}: {
  profile: RuntimeProfile;
  reader: EvmHedgeReader;
  wallet: EvmWallet;
  mode: "injected" | "local";
}) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string>();
  const [services] = useState(() => createSwapServices(profile, reader, wallet));
  useEffect(() => {
    let live = true;
    const restore = async () => {
      const prefix = `hedge:${profile.config.deployment.instance_id}:`;
      if (
        mode === "local" &&
        (localStorage.getItem(`${prefix}swap`) || localStorage.getItem(`${prefix}draft`))
      )
        await wallet.connect("hedera");
      if (live) setReady(true);
    };
    void restore().catch((error) => {
      if (live) setError(error instanceof Error ? error.message : "Could not restore swap");
    });
    return () => {
      live = false;
    };
  }, [profile, wallet, mode]);
  if (error || !ready) return <SwapLoading error={error} />;
  return (
    <SwapForm services={services} loanSummary={<LoanSummary profile={profile} reader={reader} />} />
  );
}
function WalletApproval({
  approval,
  finish,
}: {
  approval?: Approval;
  finish: (accepted: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (approval && !dialog.current?.open) dialog.current?.showModal();
    else if (!approval && dialog.current?.open) dialog.current.close();
  }, [approval]);
  let amount: string | undefined;
  if (approval) {
    try {
      const call = decodeFunctionData({ abi: tokenAbi, data: approval.tx.data });
      if (call.functionName === "approve")
        amount = `${formatUnits(call.args[1], 6)} USDC allowance`;
    } catch {
      /* Contract action label is shown below. */
    }
    try {
      const call = decodeFunctionData({ abi: hedgeLendingAbi, data: approval.tx.data });
      if (call.functionName === "repay") amount = `${formatUnits(call.args[1], 6)} USDC`;
    } catch {
      /* Not a repayment. */
    }
  }
  return (
    <dialog
      ref={dialog}
      className="hedge-modal wallet-approval"
      onCancel={(event) => {
        event.preventDefault();
        finish(false);
      }}
      aria-labelledby="wallet-title"
    >
      <header className="hedge-header">
        <h2 id="wallet-title">{approval?.tx.label}</h2>
      </header>
      <div className="hedge-body">
        <p>{approval?.tx.chain === "base" ? "Base Sepolia" : "Hedera testnet"}</p>
        {amount && <p>{amount}</p>}
        <p className="hedge-note">Estimated maximum fee: {approval?.fee}</p>
        <code className="wallet-target">{approval?.tx.to}</code>
      </div>
      <footer className="hedge-footer">
        <button className="hedge-primary" onClick={() => finish(true)}>
          Confirm transaction
        </button>
        <button className="hedge-secondary" onClick={() => finish(false)}>
          Reject
        </button>
      </footer>
    </dialog>
  );
}
