import type { Metadata } from "next";
import Link from "next/link";
import { CodeBlock } from "@/components/code-block";
import { GuideNav } from "@/components/guide-nav";
import { integrationCode } from "@/lib/site";
import { demoEvidence } from "@/lib/docs-evidence";

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
            <h2>How it works</h2>
            <p>
              Supply USDC on Hedera, set your loan terms and embed Use Hedge. Users lock Base
              collateral, borrow, then continue in your app. Chainlink CCIP confirms custody and
              repayment between the two chains.
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
              For a hosted backend, set <code>HEDGE_LOCAL_TESTNET=0</code>, use an HTTPS{" "}
              <code>/operator</code> URL in <code>hedge.config.json</code>, and set{" "}
              <code>CORS_ORIGINS</code> to your app URL. The operator signs offers and CCIP
              submissions; borrowers sign their own transactions.
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
              Starts your backend and website with your operator, rules and liquidity. Startup
              prints both URLs. The included <code>/demo</code> swaps USDC → HBAR using SaucerSwap
              on Hedera Testnet.
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
            <ul>
              <li>
                <code>wallet</code>: your app’s Base and Hedera wallet connections.
              </li>
              <li>
                <code>amount</code>: the shortfall as a decimal string, or a function that
                calculates it after connection. <code>undefined</code> disables new borrowing;{" "}
                <code>"0"</code>
                means no loan is needed.
              </li>
              <li>
                <code>onContinue</code>: resume your app action when the user continues after
                funding.
              </li>
            </ul>
          </section>
          <section className="guide-section" id="protocol">
            <h2>Loan rules</h2>
            <ul>
              <li>
                Each app funds its own pool. Offers reserve liquidity; only unused capital can be
                withdrawn.
              </li>
              <li>
                Accepted terms stay fixed. Repay the full agreed amount; early repayment keeps the
                charge.
              </li>
              <li>
                Borrowers can cancel before funding. Closing the modal does not cancel a funded
                loan.
              </li>
              <li>
                Repay in Hedera USDC and claim Base collateral, or use{" "}
                <strong>Repay with collateral</strong> if allowed. Base pays the operator and
                returns the remainder; CCIP confirms repayment.
              </li>
              <li>
                Base repayments do not refill the Hedera pool. Operators move those funds
                separately.
              </li>
              <li>
                After the repayment deadline, the operator can declare default and recover the
                agreed collateral.
              </li>
            </ul>
          </section>
          <section className="guide-section" id="evidence">
            <h2>{demoEvidence.title}</h2>
            <p>{demoEvidence.description}</p>
            <table>
              <thead>
                <tr>
                  <th scope="col">Step</th>
                  <th scope="col">Transaction</th>
                </tr>
              </thead>
              <tbody>
                {demoEvidence.receipts.map(({ step, label, url }) => (
                  <tr key={step}>
                    <td>{step}</td>
                    <td>
                      <a
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={`${step} transaction`}
                      >
                        {label}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      </div>
    </main>
  );
}
