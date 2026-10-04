import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@fontsource-variable/dm-sans";
import "./globals.css";
import { Nav } from "@/sections/landing/nav";
import { Footer } from "@/sections/landing/footer";
import { siteOrigin } from "@/lib/site";

export const metadata: Metadata = {
  metadataBase: siteOrigin,
  title: { default: "Hedge — Cross-chain borrowing for Hedera apps", template: "%s | Hedge" },
  description:
    "Bring cross-chain borrowing into your Hedera app. Let users borrow on Hedera against collateral on Base, directly from your app. Explore the local testnet demo.",
  openGraph: {
    title: "Bring cross-chain borrowing into your Hedera app.",
    description: "Collateral on Base. Credit on Hedera. One borrowing flow with Hedge.",
    type: "website",
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "Hedge: cross-chain borrowing for Hedera apps",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Hedge — Cross-chain borrowing for Hedera apps",
    images: ["/og.png"],
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-scroll-behavior="smooth">
      <body>
        <a href="#main-content" className="skip-link">
          Skip to content
        </a>
        <Nav />
        {children}
        <Footer />
      </body>
    </html>
  );
}
