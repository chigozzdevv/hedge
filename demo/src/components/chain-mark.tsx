export function ChainMark({
  chain,
  className = "",
}: {
  chain: "base" | "hedera" | "chainlink";
  className?: string;
}) {
  return (
    <svg viewBox="0 0 40 40" fill="none" className={className} aria-hidden="true">
      {chain === "base" && (
        <>
          <circle cx="20" cy="20" r="17" fill="currentColor" />
          <path d="M3 20h25" stroke="var(--color-background)" strokeWidth="4" />
        </>
      )}
      {chain === "hedera" && (
        <>
          <circle cx="20" cy="20" r="17" stroke="currentColor" strokeWidth="1.5" />
          <path d="M14 10v20m12-20v20M14 17h12M14 23h12" stroke="currentColor" strokeWidth="2.6" />
        </>
      )}
      {chain === "chainlink" && (
        <path d="m20 3 15 8.5v17L20 37 5 28.5v-17L20 3Z" stroke="currentColor" strokeWidth="5" />
      )}
    </svg>
  );
}
