import { ArrowDown } from "lucide-react";
import { ActionLink } from "@/components/action-link";
import { demoHref } from "@/lib/site";
import { BridgeArt } from "./bridge-art";

export function Hero() {
  return (
    <section className="hero relative isolate" aria-labelledby="hero-heading">
      <div className="hero-glow" aria-hidden="true" />
      <div className="shell relative text-center">
        <h1 id="hero-heading">
          Bring cross-chain borrowing
          <br className="hidden lg:block" /> into your{" "}
          <span className="hero-accent">Hedera app.</span>
        </h1>
        <p className="hero-description">
          Let users borrow on Hedera against collateral on Base,
          <br className="hidden sm:block" /> directly from your app.
        </p>
        <div className="hero-actions">
          <ActionLink href={demoHref}>Run a Demo</ActionLink>
          <ActionLink href="/docs" variant="text">
            Read the Docs
          </ActionLink>
        </div>
        <BridgeArt />
        <a href="#why-hedge" className="hero-scroll" aria-label="Discover why Hedge">
          <ArrowDown size={16} aria-hidden="true" />
        </a>
      </div>
    </section>
  );
}
