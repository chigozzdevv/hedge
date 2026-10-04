"use client";
import { useEffect, useState } from "react";
import { hedgeLendingAbi, hedgeVaultAbi } from "@hedge/bindings";
import { sameAddress, type EvmHedgeReader } from "@hedge/sdk";
import type { TokenMetadata } from "@hedge/schema";
import { formatUnits, parseUnits, type Address } from "viem";
import type { RuntimeProfile } from "./wallet-service";

type Assets = { loan: TokenMetadata; collateral: TokenMetadata };

export function LoanSummary({
  profile,
  reader,
}: {
  profile: RuntimeProfile;
  reader: EvmHedgeReader;
}) {
  const [assets, setAssets] = useState<Assets>();
  const [pool, setPool] = useState<bigint>();
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    let live = true;
    let pending = false;
    let metadata: Assets | undefined;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        await reader.verifyDeployment();
        if (!metadata) {
          const [loan, collateral] = await Promise.all([
            reader.loanToken(),
            reader.clients.base.readContract({
              address: reader.address("base"),
              abi: hedgeVaultAbi,
              functionName: "collateralAsset",
            }),
          ]);
          if (
            !sameAddress(loan, profile.assets.loan) ||
            !sameAddress(collateral, profile.assets.collateral)
          )
            throw new Error("Loan assets differ from the deployed contracts");
          const [loanToken, collateralToken] = await Promise.all([
            reader.token("hedera", loan),
            reader.token("base", collateral),
          ]);
          metadata = { loan: loanToken, collateral: collateralToken };
        }
        const available = await reader.clients.hedera.readContract({
          address: reader.address("hedera"),
          abi: hedgeLendingAbi,
          functionName: "freeCapital",
          args: [profile.config.operator as Address],
        });
        if (live) {
          setAssets(metadata);
          setPool(available);
          setUnavailable(false);
        }
      } catch {
        if (live) {
          setPool(undefined);
          setUnavailable(true);
        }
      } finally {
        pending = false;
      }
    };
    const update = () => void refresh();
    update();
    const timer = setInterval(update, 30_000);
    window.addEventListener("focus", update);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener("focus", update);
    };
  }, [profile, reader]);
  const loan = assets?.loan;
  return (
    <dl className="swap-loan-summary" aria-label="Loan information">
      <div>
        <dt title="Available liquidity for new loans">Loan pool</dt>
        <dd>
          {loan && pool !== undefined
            ? `${formatUnits(pool, loan.decimals)} ${loan.symbol}`
            : unavailable
              ? "Unavailable"
              : "…"}
        </dd>
      </div>
      <div>
        <dt>Max loan amount</dt>
        <dd>
          {loan
            ? `${formatUnits(parseUnits(profile.policy.max_loan_amount, loan.decimals), loan.decimals)} ${loan.symbol}`
            : "…"}
        </dd>
      </div>
      <div>
        <dt>Loan asset</dt>
        <dd title={loan?.address}>{loan ? `${loan.symbol} · Hedera` : "…"}</dd>
      </div>
      <div>
        <dt>Accepted collateral</dt>
        <dd title={assets?.collateral.address}>
          {assets ? `${assets.collateral.symbol} · Base` : "…"}
        </dd>
      </div>
    </dl>
  );
}
