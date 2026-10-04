import { ActionLink } from "@/components/action-link";
import { BrandMark } from "@/components/brand";
import { demoHref } from "@/lib/site";

export function Closing() {
  return (
    <section className="shell section-space">
      <div className="closing-panel">
        <div className="closing-halo" aria-hidden="true">
          <BrandMark className="size-28" />
        </div>
        <div className="relative z-10">
          <p className="eyebrow">Build with Hedge</p>
          <h2>
            Bring cross-chain borrowing
            <br className="hidden sm:block" /> to your users.
          </h2>
          <p className="mt-5 text-muted">Start with the demo. Build it into your app.</p>
          <div className="mt-9 flex flex-wrap gap-5">
            <ActionLink href={demoHref}>Run a Demo</ActionLink>
            <ActionLink href="/docs" variant="text">
              Read the Docs
            </ActionLink>
          </div>
        </div>
      </div>
    </section>
  );
}
