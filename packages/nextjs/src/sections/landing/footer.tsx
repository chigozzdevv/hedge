import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { Brand } from "@/components/brand";
import { demoHref } from "@/lib/site";

export function Footer() {
  return (
    <footer className="site-footer shell">
      <div className="grid gap-10 pb-12 sm:grid-cols-[1.6fr_1fr_1fr]">
        <div>
          <Brand />
          <p className="mt-5 max-w-xs text-sm leading-6 text-muted">
            Cross-chain credit.
            <br />
            Built into your Hedera app.
          </p>
        </div>
        <div>
          <p className="footer-label">Explore</p>
          <div className="footer-links">
            <Link href="/#how-it-works">How it works</Link>
            <Link href="/#developers">For developers</Link>
            <Link href="/#under-the-hood">Under the hood</Link>
            <Link href="/#faqs">FAQs</Link>
          </div>
        </div>
        <div>
          <p className="footer-label">Build</p>
          <div className="footer-links">
            <Link href="/docs">
              Documentation <ArrowUpRight size={13} />
            </Link>
            <Link href={demoHref}>
              Run a Demo <ArrowUpRight size={13} />
            </Link>
            <Link href="/docs#protocol">
              Protocol rules <ArrowUpRight size={13} />
            </Link>
          </div>
        </div>
      </div>
      <div className="footer-bottom">
        <p>© {new Date().getUTCFullYear()} Hedge.</p>
        <p className="flex items-center gap-2">
          <span className="status-dot" />
          Local testnet integration
        </p>
      </div>
    </footer>
  );
}
