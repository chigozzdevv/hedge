import { ChainMark } from "@/components/chain-mark";

export function Networks() {
  return (
    <section className="networks shell" aria-label="Hedge technology">
      <p className="text-xs text-muted">Two chains. One borrowing experience.</p>
      <div className="flex flex-wrap items-center justify-center gap-x-14 gap-y-7 sm:gap-x-20">
        <span className="network-name">
          <ChainMark chain="hedera" className="size-9" />
          hedera
        </span>
        <span className="network-name">
          <ChainMark chain="base" className="size-8" />
          Base
        </span>
        <span className="network-name">
          <ChainMark chain="chainlink" className="size-8" />
          <span className="text-xl">
            Chainlink <span className="text-sm text-muted">CCIP</span>
          </span>
        </span>
      </div>
    </section>
  );
}
