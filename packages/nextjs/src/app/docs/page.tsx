import type { Metadata } from "next";
import Link from "next/link";
import { TransactionLink } from "@hedge/frontend";
import { CodeBlock } from "@/components/code-block";
import { integrationCode } from "@/lib/site";

export const metadata: Metadata = {
  title: "Documentation",
  description: "Set up your Hedge operator and embed cross-chain borrowing in your app.",
};

export default function DocsPage() {
  return (
    <main id="main-content" className="shell interior-page">
      <p className="eyebrow">Build with Hedge</p>
      <h1>
        A borrowing flow.
        <br />
        <span className="text-accent">Inside your app.</span>
      </h1>
      <p className="section-description">
        Supply liquidity, set your loan terms and embed Use Hedge in your app.
      </p>
      <div className="guide-layout">
        <nav className="guide-nav" aria-label="Documentation sections">
          <a href="#overview">Overview</a>
          <a href="#setup">Setup</a>
          <a href="#integration">React integration</a>
          <a href="#protocol">Protocol rules</a>
          <a href="#evidence">Test evidence</a>
        </nav>
        <div>
          <section className="guide-section" id="overview">
            <h2>How the pieces fit together</h2>
            <p>
              Apps reuse Hedge’s shared contracts. Your platform runs its own backend, sets its
              rules and supplies its own lending capital on Hedera. Users pledge collateral on Base
              and receive their loan on Hedera. Your frontend embeds the provider and modal;
              borrowers connect, review and sign with their own wallets.
            </p>
            <p>
              Hedera owns the canonical loan outcome. Base enforces the agreed pledge. Chainlink
              CCIP carries authenticated agreement, custody and outcome messages.
            </p>
          </section>
          <section className="guide-section" id="setup">
            <h2>Set up your platform</h2>
            <p>
              From the Hedge repository, install with Node 20.19+, 22.13+, or 24+, npm, Foundry,
              Python 3 and curl.
            </p>
            <CodeBlock
              code={`npm ci\nnpm run build:contracts\nnpm run codegen\nnpm run build:packages\ncp server/.env.example server/.env`}
            />
            <p>
              Keep an existing <code>server/.env</code> when upgrading. Configure storage and the
              testnet service:
            </p>
            <CodeBlock
              label="server/.env"
              code={`DATABASE_DRIVER=postgres\nDATABASE_URL=postgresql://hedge:CHANGE_ME@127.0.0.1:5432/hedge\nHEDGE_LOCAL_TESTNET=1\nHOST=127.0.0.1\nPORT=3003\nFRONTEND_HOST=127.0.0.1\nFRONTEND_PORT=3002\nCORS_ORIGINS=http://127.0.0.1:3002`}
            />
            <p>
              Use your PostgreSQL or MongoDB connection URL. Transaction records and liquidity
              receipts go to your database.
            </p>
            <p>
              Configure loan rules in <code>packages/nextjs/.hedge/operator.json</code>. Leave{" "}
              <code>eligible_borrowers</code> empty to allow everyone, or add addresses to restrict
              eligibility. The supplied terms allow up to 10 USDC, require 2× Base USDC collateral,
              charge 2% and set a 30-day term. Borrowers connect and sign with their own wallets.
            </p>
            <h3>Prepare your operator</h3>
            <CodeBlock code={`cd packages/nextjs\nnpm run hedge -- init`} />
            <p>
              Init generates or reuses operator/relay wallets and prints their addresses. Setup
              files stay in <code>packages/nextjs/.hedge</code>. Fund the operator on Hedera Testnet
              with HBAR and the configured USDC token <code>0.0.5449</code>; fund the Base Sepolia
              wallet with ETH. The borrower also needs Hedera HBAR and the full repayment amount.
            </p>
            <p>
              The configured Hedera token differs from Circle’s Hedera test token. Follow the root
              repository README for wallet funding, retained deployment gas buffers and instance
              details.
            </p>
            <CodeBlock code={`npm run hedge -- liquidity deposit 5\nnpm run hedge -- start`} />
            <div className="guide-note">
              <p>
                The supplied <code>packages/nextjs/.hedge/hedge.config.json</code> selects the
                shared contracts. Set its <code>operator</code> to your wallet and{" "}
                <code>operator_url</code> to your backend endpoint. Liquidity commands store
                recovery records and receipts in your configured database. Each operator owns its
                balance, offers and loan rules on the shared contracts.
              </p>
            </div>
            <p>
              Apps customizing contract source can run <code>npm run hedge -- deploy</code> to
              deploy their own version and configure its new addresses. Existing contracts keep
              their code and accepted loans.
            </p>
            <p>
              Start runs your backend with your operator, rules and liquidity, plus the bundled
              website. Startup prints both URLs. Use Hedge in your own app with the integration
              below; <code>/demo</code> is the included swap example. The website serves
              <code>hedge.config.json</code> at <code>/hedge.config.json</code>. Local signing stays
              on loopback.
            </p>
            <p>
              <Link href="/demo">Open the swap demo →</Link>
            </p>
          </section>
          <section className="guide-section" id="integration">
            <h2>Embed Use Hedge in React</h2>
            <p>
              The packages are not published yet. Build and pack them from the Hedge repository:
            </p>
            <CodeBlock
              code={`npm run build:packages\nmkdir -p /tmp/hedge-packages\nnpm pack --workspace @hedge/schema --workspace @hedge/bindings \\\n  --workspace @hedge/sdk --workspace @hedge/frontend \\\n  --pack-destination /tmp/hedge-packages`}
            />
            <p>In your React 19 app, install the four tarballs and copy the public config:</p>
            <CodeBlock
              code={`npm install /tmp/hedge-packages/hedge-{schema,bindings,sdk,frontend}-0.1.0.tgz\nmkdir -p public\ncurl -fsS http://127.0.0.1:3002/hedge.config.json -o public/hedge.config.json`}
            />
            <p>Mount one provider inside your app’s wallet setup:</p>
            <CodeBlock label="app.tsx" code={`"use client";\n${integrationCode}`} language="tsx" />
            <p>
              <code>appWallet</code> supplies Base and Hedera wallet connections and asks users to
              sign transactions. <code>shortfall</code> is the amount needed, as a decimal string
              computed from the real balance. <code>resumeAppAction</code> runs after confirmed
              funding when the user chooses to continue. Your app chooses the action and button
              label; swapping is the reference example. Further transactions need wallet approval.
            </p>
            <p>
              The provider loads public config, verifies contracts and mounts one modal. It includes
              styles. Wallet credentials and operator keys stay out of public config. Configure a
              real backend and wallet services for a hosted app.
            </p>
          </section>
          <section className="guide-section" id="protocol">
            <h2>The loan and your app action are separate</h2>
            <ul>
              <li>Published offers reserve capital. Accepted terms cannot change.</li>
              <li>
                Collateral is locked on Base before custody confirmation authorizes a Hedera payout.
              </li>
              <li>
                Confirmed funding lets your app refresh its balance and quote. Users separately
                approve their next transaction.
              </li>
              <li>Closing the modal or abandoning a swap does not cancel a funded loan.</li>
              <li>
                Repayment must equal the full agreed amount. Early repayment keeps the fixed charge;
                network fees are separate.
              </li>
              <li>
                Repay in Hedera USDC and claim Base collateral, or use the agreed collateral
                repayment option. Base pays the operator and returns the remainder; CCIP confirms
                repayment on Hedera.
              </li>
              <li>
                After the repayment deadline, the operator can declare default. The agreed recovery
                recipient can then claim the pledged collateral.
              </li>
              <li>
                Base has no independent timeout release. Submitted messages and transactions are not
                proof of delivery or funding.
              </li>
            </ul>
            <p>
              Deployment policy and accepted agreements own authority. These setup notes do not
              replace the protocol rules in the root README.
            </p>
          </section>
          <section className="guide-section" id="evidence">
            <h2>Confirmed testnet runs</h2>
            <p>
              A 0.1 USDC loan used 0.2 Base USDC collateral. Repayment paid the operator 0.102 Base
              USDC and returned 0.098 Base USDC to the borrower.
            </p>
            <p>
              Base payment and return:{" "}
              <TransactionLink
                chainId={84532}
                hash="0x431b26c7724f18ab5a19fe058806d5291a4761ce34427d6f943cd325262671ed"
                label="Base payment and return"
              />
              {" · "}
              Hedera repayment confirmation:{" "}
              <TransactionLink
                chainId={296}
                hash="0xc5de9e8e4c4a36fc079fbd554bfa11bec2b75ab58a053951948339af73bc8501"
                label="Hedera repayment confirmation"
              />
            </p>
            <p>
              Hedge runs on Hedera Testnet and Base Sepolia. Full receipts are in the repository
              README.
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}
