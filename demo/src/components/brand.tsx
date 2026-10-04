import Link from "next/link";

export function BrandMark({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 36 36" fill="none" className={className} aria-hidden="true">
      <path d="M6 5h7v11l10-6V5h7v26h-7V20l-10 6v5H6V5Z" fill="currentColor" />
    </svg>
  );
}

export function Brand({ className = "" }: { className?: string }) {
  return (
    <Link href="/" aria-label="Hedge home" className={`brand ${className}`}>
      <BrandMark className="size-8" />
      <span>
        hedge<span className="text-accent">.</span>
      </span>
    </Link>
  );
}
