import { ArrowRight, FileCheck2, LockKeyhole, Wallet, RotateCcw } from "lucide-react";
import { SectionHeading } from "@/components/section-heading";

const steps = [
  {
    number: "01",
    icon: FileCheck2,
    title: "Review the loan",
    text: "Users connect their wallets and review the collateral, repayment amount and deadlines before signing.",
    label: "Terms before signatures",
    visual: "review",
  },
  {
    number: "02",
    icon: LockKeyhole,
    title: "Lock collateral on Base",
    text: "The agreed collateral is locked on Base. Cross-chain confirmation authorizes the loan payout on Hedera.",
    label: "Base → Hedera",
    visual: "lock",
  },
  {
    number: "03",
    icon: Wallet,
    title: "Receive funds on Hedera",
    text: "Once funding is confirmed, users can continue in your app and approve their next transaction.",
    label: "Your app, their next move",
    visual: "receive",
  },
] as const;

export function HowItWorks() {
  return (
    <section id="how-it-works" className="shell section-space">
      <SectionHeading centered description="From collateral to capital, without leaving your app.">
        One borrowing flow.
        <br />
        <span className="text-muted">Across two chains.</span>
      </SectionHeading>
      <div className="mt-14 grid gap-5 md:grid-cols-3">
        {steps.map(({ number, icon: Icon, title, text, label, visual }) => (
          <article key={number} className="step-card">
            <div className={`step-art step-${visual}`} aria-hidden="true">
              <div className="step-art-grid" />
              <span className="step-number">{number}</span>
              <div className="step-icon">
                <Icon size={34} strokeWidth={1.2} />
              </div>
              <span className="step-label">{label}</span>
            </div>
            <div className="px-7 pb-8 pt-6">
              <h3>{title}</h3>
              <p className="mt-3 text-sm leading-7 text-muted">{text}</p>
            </div>
          </article>
        ))}
      </div>
      <div className="repay-note">
        <RotateCcw size={16} aria-hidden="true" />
        <span>Repay on Hedera.</span>
        <ArrowRight size={14} className="hidden sm:block" aria-hidden="true" />
        <span>Reclaim collateral on Base.</span>
      </div>
    </section>
  );
}
