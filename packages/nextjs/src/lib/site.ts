export const navigation = [
  { label: "How it works", href: "/#how-it-works" },
  { label: "For developers", href: "/#developers" },
  { label: "FAQs", href: "/#faqs" },
  { label: "Docs", href: "/docs" },
] as const;

export const demoHref = "/demo";

export const siteOrigin = (() => {
  try {
    const url = new URL(process.env["NEXT_PUBLIC_SITE_URL"] ?? "http://127.0.0.1:3002");
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
      return new URL("http://127.0.0.1:3002");
    return url;
  } catch {
    return new URL("http://127.0.0.1:3002");
  }
})();

export const faqs = [
  {
    question: "Who provides the lending capital?",
    answer:
      "Your app’s operator supplies the capital on Hedera. Published offers reserve available funds for the loan, so each offer is backed by lending capital.",
  },
  {
    question: "Do users need wallets on both chains?",
    answer:
      "Yes. Connect Base for collateral and Hedera for the loan. Users review and sign with their own wallets. The demo uses the same configured operator, rules and liquidity as the app integration.",
  },
  {
    question: "Does borrowing automatically complete a swap?",
    answer:
      "No. Hedge provides the loan. After confirmed funding, your app refreshes the user’s balance and quote. The user reviews and approves the swap separately. Closing the modal does not cancel a funded loan.",
  },
  {
    question: "How do users get their collateral back?",
    answer:
      "Repay in Hedera USDC and claim your Base collateral. If your offer allows Repay with collateral, Base pays the operator and returns the remainder. Chainlink CCIP confirms repayment on Hedera. Early repayment keeps the agreed charge.",
  },
  {
    question: "What happens if a loan isn’t repaid?",
    answer:
      "After the repayment deadline, the operator can declare a funded loan in default. The pledged collateral then becomes claimable by the recovery recipient specified in the agreement.",
  },
  {
    question: "Is Hedge available on mainnet?",
    answer:
      "Hedge currently runs on Hedera Testnet and Base Sepolia. Mainnet support is not available.",
  },
] as const;

export const integrationCode = `import { HedgeProvider, UseHedge } from "@hedge/frontend";

<HedgeProvider wallet={appWallet}>
  <UseHedge
    amount={shortfall}
    continueLabel="Continue"
    onContinue={resumeAppAction}
  />
</HedgeProvider>`;
