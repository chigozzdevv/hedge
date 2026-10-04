import type { Metadata } from "next";
import Link from "next/link";
import { CodeBlock } from "@/components/code-block";
import { GuideNav } from "@/components/guide-nav";
import { integrationCode } from "@/lib/site";
import { testRuns } from "@/lib/docs-evidence";

export const metadata: Metadata = {
  title: "Documentation",
  description: "Set up your Hedge operator and embed cross-chain borrowing in your app.",
};

export default function DocsPage() {
  return (
    <main id="main-content" className="shell interior-page">
      <div className="guide-layout">
        <GuideNav />
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
            <p>Requires Node 20.19+, 22.13+, or 24+, npm, Git, Foundry, Python 3 and curl.</p>
            <h3>1. Create your app</h3>
            <CodeBlock code="npm create scaffold-hbar@latest -- --template chigozzdevv/hedge" />
            <p>Choose your project name and npm, then enter the generated folder.</p>
            <h3>2. Install and initialize wallets</h3>
            <CodeBlock
              code={`npm ci
npm run build:contracts
npm run codegen
npm run build:packages
cp .env.example .env
cd packages/nextjs
npm run hedge -- init`}
            />
            <p>
              Keep an existing root <code>.env</code> when upgrading. Run Hedge commands from your
              app folder, <code>packages/nextjs</code> here. Init creates or reuses the
              operator/relay wallets, prints their addresses and fills the operator address on first
              initialization.
            </p>
            <h3>3. Configure your platform</h3>
            <p>
              The root <code>.env</code> is shared by the CLI, server and website. Set your database
              connection and enable the testnet service:
            </p>
            <CodeBlock
              label=".env"
              language="dotenv"
              code={`DATABASE_DRIVER=postgres
DATABASE_URL=postgresql://hedge:CHANGE_ME@127.0.0.1:5432/hedge
HEDGE_LOCAL_TESTNET=1`}
            />
            <p>
              For MongoDB, use <code>DATABASE_DRIVER=mongodb</code> and your MongoDB connection URL;
              multi-record transactions require a replica set. Transaction records, receipts,
              process state and logs go to your database. The supplied ports are 3003 for the server
              and 3002 for the app; startup derives the local URLs and browser origin.
            </p>
            <p>
              Your app’s <code>.hedge</code> contains only <code>wallets.json</code>,{" "}
              <code>operator.json</code> and <code>hedge.config.json</code>. The wallets file
              contains unencrypted private keys; keep it private with permissions <code>0600</code>.
              It is ignored by Git and never served to the browser.
            </p>
            <details>
              <summary>Loan rules · .hedge/operator.json</summary>
              <CodeBlock
                label="operator.json"
                language="json"
                code={`{
  "loan_asset": {
    "chain_id": 296,
    "symbol": "USDC",
    "address": "0x0000000000000000000000000000000000001549"
  },
  "accepted_collateral": {
    "chain_id": 84532,
    "symbol": "USDC",
    "address": "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
  },
  "max_loan_amount": "10",
  "collateral_ratio": "2",
  "financing_charge_percent": "2",
  "term_days": 30,
  "repay_with_collateral": true,
  "eligible_borrowers": []
}`}
              />
              <p>
                An empty borrower list allows everyone who meets the terms. Assets must match the
                selected contracts. Restart after rule edits; accepted loans retain their agreed
                terms.
              </p>
            </details>
            <details>
              <summary>Public settings · .hedge/hedge.config.json</summary>
              <CodeBlock
                label="hedge.config.json"
                language="json"
                code={`{
  "deployment_file": "deployments/testnet.json",
  "operator": "<HEDERA_OPERATOR_ADDRESS>",
  "operator_url": "http://127.0.0.1:3003/testnet",
  "rpc": {
    "hedera": "https://testnet.hashio.io/api",
    "base": "https://sepolia.base.org"
  },
  "mirror_url": "https://testnet.mirrornode.hedera.com"
}`}
              />
              <p>
                The supplied deployment selects the shared contracts. Init fills your operator
                address; set the endpoint to your backend. Startup verifies your settings and serves
                the resolved public config at <code>/hedge.config.json</code>.
              </p>
            </details>
            <h3>4. Fund wallets and deposit liquidity</h3>
            <ul>
              <li>
                Operator: Hedera USDC <code>0.0.5449</code> for lending and HBAR above the default 5
                HBAR gas reserve.
              </li>
              <li>Relay: Base Sepolia ETH for gas.</li>
              <li>
                Borrower: Base USDC collateral and ETH, plus Hedera HBAR and USDC for gas and
                repayment.
              </li>
            </ul>
            <p>
              Fund HBAR first, then associate <code>0.0.5449</code> if automatic token association
              is unavailable. This token must come from a holder or compatible pool; Circle’s Hedera
              test token <code>0.0.429274</code> is different. A 1 USDC loan requires 2 Base USDC
              collateral and 1.02 USDC repayment.
            </p>
            <CodeBlock code="npm run hedge -- liquidity deposit 5" />
            <p>
              Stop managed services before deposits or withdrawals. Retry to resume an interrupted
              transaction.
            </p>
            <h3>5. Start your platform</h3>
            <CodeBlock code="npm run hedge -- start" />
            <p>
              Start runs your backend with your operator, rules and liquidity, plus the bundled
              website. Startup prints both URLs. Use Hedge in your own app with the integration
              below; <code>/demo</code> is the included USDC → HBAR swap using SaucerSwap on Hedera
              Testnet. Borrowers connect and sign with their own wallets. The supplied test service
              runs on loopback.
            </p>
            <p>Stop your services:</p>
            <CodeBlock code="npm run hedge -- stop" />
            <p>
              Use <code>npm run hedge -- restart</code> after config or code edits. Apps changing
              contract source can stop services and run <code>npm run hedge -- deploy</code> for a
              new pair; existing contracts and loan obligations remain intact.
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
              code={`npm install \\
  /tmp/hedge-packages/hedge-{schema,bindings,sdk,frontend}-0.1.0.tgz
mkdir -p public
curl -fsS http://127.0.0.1:3002/hedge.config.json \\
  -o public/hedge.config.json`}
            />
            <p>
              Use your running website’s URL to fetch the config. Set its <code>operator_url</code>
              to your backend and allow the app origin in the root <code>CORS_ORIGINS</code>. You
              can also pass the provider a hosted <code>config</code> URL.
            </p>
            <p>Mount one provider inside your app’s wallet setup:</p>
            <CodeBlock
              label="app.tsx"
              code={`"use client";\n\n${integrationCode};`}
              language="tsx"
            />
            <p>
              <code>appWallet</code> supplies Base and Hedera wallet connections and asks users to
              sign transactions. <code>shortfall</code> is the amount needed, as a decimal string
              computed from the real balance, such as <code>"0.1"</code>. Hedera wallet identities
              include the account ID. <code>resumeAppAction</code> runs after confirmed funding when
              the user chooses to continue. Your app chooses the action and button label; swapping
              is the reference example. Further transactions need wallet approval.
            </p>
            <p>
              The provider loads public config, verifies contracts and mounts one modal. It includes
              styles. Wallet credentials and operator keys stay out of public config. Configure a
              real backend and wallet services for a hosted app; the supplied loopback test service
              cannot serve remote users.
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
                repayment on Hedera. The operator must rebalance Base receipts separately to
                replenish Hedera liquidity.
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
            <h2>Recorded testnet runs</h2>
            <p>
              Hedera Testnet and Base Sepolia. Receipt links identify the contracts used in each
              run.
            </p>
            {testRuns.map(({ title, description, receipts }) => (
              <div key={title}>
                <h3>{title}</h3>
                <p>{description}</p>
                <details>
                  <summary>Transaction receipts</summary>
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">Step</th>
                        <th scope="col">Receipt</th>
                      </tr>
                    </thead>
                    <tbody>
                      {receipts.map(({ step, label, url }) => (
                        <tr key={step}>
                          <td>{step}</td>
                          <td>
                            <a
                              href={url}
                              target="_blank"
                              rel="noreferrer"
                              aria-label={`${step} receipt`}
                            >
                              {label}
                            </a>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              </div>
            ))}
            <p>
              Run <code>npm run check</code> for local validation. Last verified coverage: 333
              TypeScript and 150 Solidity tests. These recorded runs are testnet evidence.
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}
