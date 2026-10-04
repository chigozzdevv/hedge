import { CircleDollarSign, Layers3, ArrowRight } from "lucide-react";
import { ActionLink } from "@/components/action-link";
import { CodeBlock } from "@/components/code-block";
import { SectionHeading } from "@/components/section-heading";
import { integrationCode } from "@/lib/site";

const features = [
  {
    icon: CircleDollarSign,
    title: "Your capital",
    text: "Fund loans on Hedera with capital supplied by your platform.",
  },
  {
    icon: Layers3,
    title: "An embedded experience",
    text: "Add Use Hedge for loan review, collateral locking, repayment and collateral claims.",
  },
  {
    icon: ArrowRight,
    title: "A clear handoff",
    text: "After confirmed funding, refresh your app’s balance and quote so users can continue.",
  },
];

export function Developers() {
  return (
    <section id="developers" className="developers-section section-space">
      <div className="shell grid grid-cols-1 items-center gap-14 lg:grid-cols-2 lg:gap-20">
        <div>
          <SectionHeading>
            Embed cross-chain credit
            <br className="hidden xl:block" /> in your Hedera apps.
          </SectionHeading>
          <p className="section-description">
            Supply the lending capital. Publish your offers. Let Hedge handle the borrowing flow
            inside your app.
          </p>
          <div className="mt-9 space-y-7">
            {features.map(({ icon: Icon, title, text }) => (
              <div key={title} className="flex gap-4">
                <div className="feature-icon">
                  <Icon size={20} strokeWidth={1.5} />
                </div>
                <div>
                  <h3 className="text-base font-medium">{title}</h3>
                  <p className="mt-1.5 max-w-sm text-sm leading-6 text-muted">{text}</p>
                </div>
              </div>
            ))}
          </div>
          <ActionLink href="/docs#integration" variant="text" className="mt-8">
            Explore the integration
          </ActionLink>
        </div>
        <div className="integration-panel">
          <CodeBlock label="app.tsx" code={integrationCode} language="tsx" />
        </div>
      </div>
    </section>
  );
}
