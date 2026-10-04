"use client";

import Link from "next/link";
import { Menu, X } from "lucide-react";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Brand } from "@/components/brand";
import { ActionLink } from "@/components/action-link";
import { demoHref, navigation } from "@/lib/site";

export function Nav() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <header className="site-header">
      <nav className="shell nav-inner" aria-label="Main navigation">
        <Brand />
        <div className="hidden items-center gap-8 md:flex">
          {navigation.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="nav-link"
              aria-current={pathname === item.href ? "page" : undefined}
            >
              {item.label}
            </Link>
          ))}
        </div>
        <div className="flex items-center gap-4">
          <ActionLink href={demoHref} className="nav-action hidden sm:inline-flex">
            Run a Demo
          </ActionLink>
          <button
            type="button"
            className="menu-button md:hidden"
            aria-label={open ? "Close navigation" : "Open navigation"}
            aria-expanded={open}
            aria-controls="mobile-navigation"
            onClick={() => setOpen(!open)}
          >
            {open ? <X size={23} /> : <Menu size={23} />}
          </button>
        </div>
        {open && (
          <div id="mobile-navigation" className="mobile-navigation md:hidden">
            {navigation.map((item) => (
              <Link key={item.href} href={item.href} onClick={() => setOpen(false)}>
                {item.label}
              </Link>
            ))}
            <Link href={demoHref} onClick={() => setOpen(false)}>
              Run a Demo <span aria-hidden="true">↗</span>
            </Link>
          </div>
        )}
      </nav>
    </header>
  );
}
