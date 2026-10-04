import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import type { ReactNode } from "react";

export function ActionLink({
  href,
  children,
  variant = "primary",
  className = "",
  arrow = true,
}: {
  href: string;
  children: ReactNode;
  variant?: "primary" | "secondary" | "text";
  className?: string;
  arrow?: boolean;
}) {
  return (
    <Link href={href} className={`action-link action-${variant} ${className}`}>
      {children}
      {arrow && <ArrowUpRight size={17} aria-hidden="true" />}
    </Link>
  );
}
