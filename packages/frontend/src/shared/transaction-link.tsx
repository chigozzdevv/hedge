import "./transaction-link.css";

const explorers: Record<number, { name: string; url: string; nativeHash?: boolean }> = {
  295: { name: "Hedera", url: "https://hashscan.io/mainnet/transaction/", nativeHash: true },
  296: {
    name: "Hedera Testnet",
    url: "https://hashscan.io/testnet/transaction/",
    nativeHash: true,
  },
  8453: { name: "Base", url: "https://basescan.org/tx/" },
  84532: { name: "Base Sepolia", url: "https://sepolia.basescan.org/tx/" },
};

export function TransactionLink({
  chainId,
  hash,
  label,
}: {
  chainId?: number;
  hash: string;
  label: string;
}) {
  const explorer = chainId === undefined ? undefined : explorers[chainId];
  const valid =
    /^0x[\da-f]{64}$/i.test(hash) || (explorer?.nativeHash && /^0x[\da-f]{96}$/i.test(hash));
  const short = hash.length > 20 ? `${hash.slice(0, 10)}…${hash.slice(-6)}` : hash;
  if (!explorer || !valid) return <span title={hash}>{short}</span>;
  return (
    <a
      className="hedge-transaction-link"
      href={`${explorer.url}${hash}`}
      target="_blank"
      rel="noopener noreferrer"
      title={hash}
      aria-label={`${label} transaction on ${explorer.name}`}
    >
      <span>{short}</span>
      <span aria-hidden="true">↗</span>
    </a>
  );
}
