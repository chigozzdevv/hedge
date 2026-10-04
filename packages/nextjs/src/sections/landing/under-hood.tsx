import { ArrowLeftRight, ArrowUpRight } from "lucide-react";
import { ChainMark } from "@/components/chain-mark";
import { SectionHeading } from "@/components/section-heading";

const technologies = [
  {
    name: "Hedera",
    chain: "hedera",
    href: "https://docs.hedera.com/hedera",
    role: "USDC loans and repayment.",
  },
  {
    name: "Base",
    chain: "base",
    href: "https://docs.base.org",
    role: "USDC collateral and returns.",
  },
  {
    name: "Chainlink CCIP",
    chain: "chainlink",
    href: "https://docs.chain.link/ccip",
    role: "Agreement, custody and outcome messages.",
  },
  {
    name: "SaucerSwap",
    href: "https://docs.saucerswap.finance/developers/v1/swap/swap-tokens-for-hbar",
    role: "USDC → HBAR quotes and swaps in the demo.",
  },
] as const;

export function UnderHood() {
  return (
    <section id="under-the-hood" className="shell section-space">
      <SectionHeading centered>Under the hood</SectionHeading>
      <dl className="mt-10 grid gap-x-8 gap-y-7 sm:grid-cols-2 lg:grid-cols-4">
        {technologies.map((technology) => (
          <div key={technology.name} className="border-t border-white/10 pt-5">
            <dt>
              <a
                href={technology.href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-3 text-sm font-medium hover:text-accent"
              >
                {"chain" in technology ? (
                  <ChainMark chain={technology.chain} className="size-6 shrink-0" />
                ) : (
                  <ArrowLeftRight size={24} strokeWidth={1.5} aria-hidden="true" />
                )}
                {technology.name}
                <ArrowUpRight size={13} className="text-muted" aria-hidden="true" />
              </a>
            </dt>
            <dd className="mt-3 text-sm leading-6 text-muted">{technology.role}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
