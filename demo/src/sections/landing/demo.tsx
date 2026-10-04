import { ArrowRight, ArrowUpRight, CornerDownLeft } from "lucide-react";
import { ActionLink } from "@/components/action-link";
import { SectionHeading } from "@/components/section-heading";
import { ChainMark } from "@/components/chain-mark";
import { demoHref } from "@/lib/site";

export function Demo() {
  return (
    <section id="demo" className="shell section-space">
      <div className="demo-panel">
        <div className="max-w-lg">
          <SectionHeading>See Hedge in action.</SectionHeading>
          <p className="section-description">
            Borrow on Hedera, make a separate swap, repay the loan, and reclaim collateral on Base.
          </p>
          <ActionLink href={demoHref} className="mt-8">
            Run a Demo
          </ActionLink>
          <p className="mt-5 flex items-center gap-2 text-xs text-muted">
            <span className="status-dot" />
            Hedera Testnet · Base Sepolia
          </p>
        </div>
        <div
          className="journey-art"
          aria-label="Loan journey: collateral, borrowing, swap, repayment, return"
        >
          <div className="journey-row">
            <span className="journey-chain">
              <ChainMark chain="base" className="size-6" />
              Base
            </span>
            <span>Collateral</span>
            <ArrowUpRight size={17} className="text-accent" />
          </div>
          <div className="journey-connector" />
          <div className="journey-row">
            <span className="journey-chain">
              <ChainMark chain="hedera" className="size-6" />
              Hedera
            </span>
            <span>
              Borrow <ArrowRight size={12} /> Swap
            </span>
            <ArrowUpRight size={17} className="text-accent" />
          </div>
          <div className="journey-connector" />
          <div className="journey-row">
            <span className="journey-chain">
              <CornerDownLeft size={20} className="text-accent" />
              Repay
            </span>
            <span>Reclaim collateral</span>
          </div>
        </div>
      </div>
    </section>
  );
}
