import { ArrowUpRight, Code2, LockKeyhole, Wallet } from "lucide-react";
import { BrandMark } from "@/components/brand";
import { SectionHeading } from "@/components/section-heading";

export function WhyHedge() {
  return (
    <section id="why-hedge" className="shell section-space">
      <div className="why-panel">
        <div className="relative z-10 max-w-xl">
          <SectionHeading>
            Their assets are on Base.
            <br />
            <span className="text-muted">They want to use Hedera.</span>
          </SectionHeading>
          <p className="section-description">
            Give users a way to access funds on Hedera without selling their Base assets. With
            Hedge, they pledge collateral, receive a loan, and continue in your app.
          </p>
          <a href="#how-it-works" className="inline-link mt-8">
            See how it works <ArrowUpRight size={17} aria-hidden="true" />
          </a>
        </div>
        <div className="orbit-art" aria-hidden="true">
          <div className="orbit-ring" />
          <div className="orbit-core">
            <BrandMark className="size-12" />
          </div>
          <div className="orbit-tile orbit-one">
            <Wallet size={30} />
          </div>
          <div className="orbit-tile orbit-two">
            <ArrowUpRight size={34} />
          </div>
          <div className="orbit-tile orbit-three">
            <LockKeyhole size={29} />
          </div>
          <div className="orbit-tile orbit-four">
            <Code2 size={31} />
          </div>
        </div>
      </div>
    </section>
  );
}
