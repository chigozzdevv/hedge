import type { Metadata } from "next";
import { RuntimeApp } from "@/runtime/runtime-app";
import "./demo.css";

export const metadata: Metadata = {
  title: "Swap demo",
  description:
    "Swap USDC to HBAR on Hedera Testnet with Use Hedge borrowing, repayment and collateral return.",
};

export default function DemoPage() {
  return (
    <main id="main-content" className="swap-page">
      <RuntimeApp />
    </main>
  );
}
