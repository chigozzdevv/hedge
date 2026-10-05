# Hedge

Hedge lets apps run cross-chain borrowing on Hedera. Each platform runs its own
backend, sets loan rules and supplies liquidity on shared contracts. Users connect
their wallets, borrow USDC on Hedera against USDC collateral on Base, then continue
with an app action.

**Networks:** Hedera Testnet and Base Sepolia. **Messaging:** Chainlink CCIP.

**Swap demo:** [hedge-hedera.vercel.app/demo](https://hedge-hedera.vercel.app/demo)
uses [SaucerSwap](https://docs.saucerswap.finance/developers/v1/swap/swap-tokens-for-hbar)
to quote and swap USDC → HBAR on Hedera Testnet.

## How it works

1. Your app supplies lending USDC and sets the loan terms.
2. Users open **Use Hedge**, connect Base and Hedera, and review their offer.
3. They accept the loan and lock collateral on Base. CCIP confirms custody;
   the lending contract sends USDC to their Hedera wallet.
4. They continue in your app, such as reviewing and confirming a swap.
5. They repay in Hedera USDC and claim their Base collateral, or choose
   **Repay with collateral**: Base pays the agreed amount to the operator and
   returns the remainder. CCIP confirms repayment on Hedera.

### Loan terms

The supplied `packages/nextjs/.hedge/operator.json` sets:

| Setting             | Value                |
| ------------------- | -------------------- |
| Loan asset          | USDC on Hedera       |
| Accepted collateral | USDC on Base         |
| Maximum loan        | 10 USDC              |
| Collateral required | 2× the loan amount   |
| Financing charge    | 2%                   |
| Repayment term      | 30 days from funding |

Repayment is one full payment; early repayment keeps the agreed charge. Network
fees are separate. Collateral repayment accepts Base USDC at the agreed 1:1 rate.
After the repayment deadline, the operator can claim the agreed collateral on default.

## End-to-end transactions

Our demo integration in `packages/nextjs` completed the full cycle using the public integration path on Hedera Testnet and Base Sepolia.

**Borrow, swap, repay and collateral return transaction hashes**

| Step                                       | Transaction                                                                                                                        |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Accept loan                                | [0x93dd275d…7cca58 ↗](https://hashscan.io/testnet/transaction/0x93dd275d8f77db3880db265109267f6990e20404622bd128f85d2f377e7cca58) |
| Lock collateral                            | [0xac63ce67…7b4a99 ↗](https://sepolia.basescan.org/tx/0xac63ce67feae2a590b9ac91d2e58bef314c6a37bcd4374ad3f901c34ef7b4a99)         |
| Receive funds                              | [0x695c6d90…de9a88 ↗](https://hashscan.io/testnet/transaction/0x695c6d903053a61a7f7a1d8e21b40e0335cc79d9b9db6461f0a1eb1b1ade9a88) |
| Swap USDC → HBAR                           | [0x623a52f9…e1ca83 ↗](https://hashscan.io/testnet/transaction/0x623a52f98bdbc8279a12a11169dedb490027e629ade020630a34f23954e1ca83) |
| Authorize repayment                        | [0xbf8bd7a0…15c4dc ↗](https://hashscan.io/testnet/transaction/0xbf8bd7a01eb174f8ae02d52133937a3475e9d67c403d28d371120a81cd15c4dc) |
| Repay with collateral and return remainder | [0x465b21b3…044bfd ↗](https://sepolia.basescan.org/tx/0x465b21b38e09347454ea5f9d3fd9190939d7dead2ab1d944077b688a2c044bfd)         |
| Confirm repayment                          | [0x6453cfc8…4612ae ↗](https://hashscan.io/testnet/transaction/0x6453cfc88403f159987f143b49a55969b8600d9f408b2c6c95e535d7624612ae) |

## Setup

Requires Node 20.19+, 22.13+, or 24+, npm, Git, Foundry, Python 3 and curl.

### 1. Create your app

```sh
npm create scaffold-hbar@latest -- --template chigozzdevv/hedge
```

Choose your project name and npm, then enter the generated folder.

### 2. Install and initialize wallets

```sh
npm ci
npm run build:contracts
npm run codegen
npm run build:packages
cp .env.example .env
cd packages/nextjs
npm run hedge -- init
```

Run Hedge commands from your app folder (`packages/nextjs/` here). The repository command also
uses `packages/nextjs/` by default. Keep an existing root `.env` when upgrading.
`init` creates or reuses the operator/relay wallets and prints their addresses.
On the first initialization it fills the operator address in the supplied settings.
Borrowers connect their own wallets.

```text
packages/nextjs/.hedge/
  wallets.json
  operator.json
  hedge.config.json
```

These are the only setup files in `.hedge`. Transaction recovery, service state and
logs use your configured database.

### 3. Configure your platform

`packages/nextjs/.hedge/wallets.json` contains the operator and relay keys filled by `init`:

```json
{
  "hedera": {
    "address": "<HEDERA_OPERATOR_ADDRESS>",
    "private_key": "<HEDERA_PRIVATE_KEY>"
  },
  "base": {
    "address": "<BASE_RELAY_ADDRESS>",
    "private_key": "<BASE_PRIVATE_KEY>"
  }
}
```

This file contains unencrypted private keys. Keep it private (`0600`); it is ignored by
Git and never served to the browser.

`packages/nextjs/.hedge/operator.json` sets the lending rules:

```json
{
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
}
```

An empty `eligible_borrowers` list allows everyone who meets the terms. Asset addresses
must match the selected contracts; startup checks them. Restart after editing rules;
accepted loans retain their agreed terms.

`packages/nextjs/.hedge/hedge.config.json` selects your operator and public connection details:

```json
{
  "deployment_file": "deployments/testnet.json",
  "operator": "<HEDERA_OPERATOR_ADDRESS>",
  "operator_url": "http://127.0.0.1:3003/testnet",
  "rpc": {
    "hedera": "https://testnet.hashio.io/api",
    "base": "https://sepolia.base.org"
  },
  "mirror_url": "https://testnet.mirrornode.hedera.com"
}
```

`deployments/testnet.json` supplies the shared contracts and network settings.
The website serves your public settings at `/hedge.config.json`.

The root `.env` is shared by the CLI, server and website. Set your database connection
and enable the testnet service:

```dotenv
DATABASE_DRIVER=postgres
DATABASE_URL=postgresql://hedge:CHANGE_ME@127.0.0.1:5432/hedge

HEDGE_LOCAL_TESTNET=1
```

For MongoDB, replace the database lines:

```dotenv
DATABASE_DRIVER=mongodb
DATABASE_URL=mongodb://127.0.0.1:27017/hedge
```

Startup applies migrations/indexes. Transactions, receipts, process state and logs
go to your configured database. `PORT` and `FRONTEND_PORT` select the service ports;
startup derives the local URLs and browser origin. `NEXT_PUBLIC_SITE_URL` is optional
for a hosted website. Redis is optional. Wallet keys stay in
`packages/nextjs/.hedge/wallets.json`.

For a hosted backend, set `HEDGE_LOCAL_TESTNET=0`, use an HTTPS `/operator` URL
in `hedge.config.json`, and set `CORS_ORIGINS` to your app URL. The operator signs offers and CCIP submissions; borrowers sign their own transactions.

<details>
<summary>Start PostgreSQL locally</summary>

Use the same password in `DATABASE_URL`:

```sh
docker run -d --name hedge-postgres \
  -p 127.0.0.1:5432:5432 \
  -e POSTGRES_USER=hedge -e POSTGRES_PASSWORD=CHANGE_ME -e POSTGRES_DB=hedge \
  -v hedge-postgres:/var/lib/postgresql/data postgres:15-alpine
```

MongoDB multi-record transactions require a replica set.

</details>

### 4. Fund wallets and deposit liquidity

| Wallet          | Fund with                                                                          |
| --------------- | ---------------------------------------------------------------------------------- |
| Hedera operator | HBAR for gas/CCIP and Hedera USDC `0.0.5449` for lending                           |
| Base relay      | Base Sepolia ETH for gas                                                           |
| Borrower        | Base USDC collateral, Hedera HBAR/USDC for gas and repayment, Base ETH for signing |

For a 1 USDC loan, the borrower pledges 2 Base USDC and repays 1.02 Hedera USDC.
Spending the loan in a swap still leaves the full repayment due.
Fund the operator above the default **5 HBAR** retained gas reserve.

Get [test HBAR](https://docs.hedera.com/learn/getting-started/testnet-faucet)
and [Base Sepolia USDC](https://faucet.circle.com/). Hedera USDC **`0.0.5449`** must
come from a holder or compatible pool; Circle’s `0.0.429274` is a different token.
Fund HBAR first to create the Hedera account, then associate `0.0.5449` before receiving
USDC if the account does not have automatic token association enabled.

```sh
npm run hedge -- liquidity deposit 5
```

Stop managed services before deposits or withdrawals. Retry the same command to
resume an interrupted transaction.

### 5. Start your platform

```sh
npm run hedge -- start
```

This starts your backend with your configured operator, rules and liquidity,
plus the bundled website. Startup prints both URLs. Integrate Use Hedge in your
own app using the React setup below; `/demo` is the included swap example.
The website serves the public settings from `packages/nextjs/.hedge/hedge.config.json` at
`/hedge.config.json`; it never serves the wallets file.

To stop your services:

```sh
npm run hedge -- stop
```

The swap example is at `http://127.0.0.1:3002/demo` with the setup ports above:

**Enter USDC amount → Use Hedge → connect wallets → review/sign the loan →
receive USDC → Continue to swap → Confirm swap.**
Use **Manage loan** in the same modal to repay. The demo uses the configured
operator, loan rules and liquidity; borrowers connect their own wallets.

| Command                                 | Purpose                                                     |
| --------------------------------------- | ----------------------------------------------------------- |
| `npm run hedge -- init`                 | Generate/reuse operator and relay wallets                   |
| `npm run hedge -- liquidity`            | Read available/reserved capital and HBAR balance            |
| `npm run hedge -- liquidity deposit 5`  | Deposit 5 USDC                                              |
| `npm run hedge -- liquidity withdraw 1` | Withdraw 1 USDC of free capital                             |
| `npm run hedge -- start`                | Verify and start services; also the default `npm run hedge` |
| `npm run hedge -- restart`              | Rebuild/restart after configuration or code edits           |
| `npm run hedge -- logs nextjs`          | Read website logs; use `server` for API logs                |
| `npm run hedge -- stop`                 | Stop managed services; retain database, wallets and capital |

## React integration

Requires React/React DOM 19 and the app’s Base/Hedera wallet services:

```tsx
import { HedgeProvider, UseHedge } from "@hedge/frontend";

<HedgeProvider wallet={appWallet}>
  <YourSwapForm />
  <UseHedge
    amount={formValid ? calculateShortfall : undefined}
    continueLabel="Continue to swap"
    onContinue={refreshBalanceAndQuote}
  />
</HedgeProvider>;
```

- `wallet`: your app's [Base and Hedera wallet connections](packages/sdk/src/evm/evm-adapter.ts).
- `amount`: the shortfall as a decimal string, or a function that calculates it after connection.
  `undefined` disables new borrowing; `"0"` means no loan is needed.
- `onContinue`: resume your app action when the user continues after funding.

For installation in another React app, see the [integration guide](https://hedge-hedera.vercel.app/docs#integration).

## Deployment

Apps reuse the shared contracts in [`deployments/testnet.json`](deployments/testnet.json).
Each app supplies its own liquidity and sets its loan rules.

| Network              | Current contract                                                                                                              | Asset                                             |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Hedera Testnet (296) | [0xd2bec2da396a7b4c0f3b6ecf6daba410fba17bc6](https://hashscan.io/testnet/contract/0.0.10855309)                               | USDC `0.0.5449`                                   |
| Base Sepolia (84532) | [0xd0abae3256b937463362eb2cb3f4cbfa2a858caf](https://sepolia.basescan.org/address/0xd0abae3256b937463362eb2cb3f4cbfa2a858caf) | USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |

For custom contracts, run `npm run hedge -- stop`, then `npm run hedge -- deploy`.
This creates a new pair with 5 USDC initial liquidity and updates your settings.

## Reference

Run `npm run check` to validate contracts, bindings and TypeScript.

<details>
<summary>Protocol rules</summary>

- Each app funds its own pool. Offers reserve liquidity; only unused capital can be withdrawn.
- Accepted terms stay fixed. Repay the full agreed amount; early repayment keeps the charge.
- Borrowers can cancel before funding. Closing the modal does not cancel a funded loan.
- Repay in Hedera USDC and claim Base collateral, or use **Repay with collateral** if allowed.
  Base pays the operator and returns the remainder; CCIP confirms repayment.
- Base repayments do not refill the Hedera pool. Operators move those funds separately.
- After the repayment deadline, the operator can declare default and recover the agreed collateral.

</details>

<details>
<summary>CCIP provenance and checksums</summary>

The six files under `packages/foundry/vendor/ccip-2.0.0/` are unmodified MIT-licensed
consumer files from the official `@chainlink/contracts-ccip@2.0.0` tarball on npm.
Router/token-pool runtime contracts are not vendored or deployed by Hedge.

- [Official tarball on npm](https://registry.npmjs.org/@chainlink/contracts-ccip/-/contracts-ccip-2.0.0.tgz)
- Integrity: `sha512-P0KvQtZSYC1LevMSS16jOOSsqZG4g0n/MJdcWGmE0Z5U01NVYd1MnTQJOBPsbu1NWR79DBXPXLvyr9tR5y+tiw==`
- `libraries/Client.sol`: SHA-256 `9a8b02a4cf05f2a6a75287fb37f3a271404ccb477af0da001ac7b93835ad39cd`
- `interfaces/IRouterClient.sol`: SHA-256 `05fc882e5af0dfc2840d99ed887b5c405cf555525cc8d1329787dac369dff1e3`
- `interfaces/IAny2EVMMessageReceiver.sol`: SHA-256 `a2e161a2c241a5e0a1807bdf908d47eb8527f349bc2f56c6fbcc6bcf2c3ba4c2`
- `interfaces/IAny2EVMMessageReceiverV2.sol`: SHA-256 `c88f880ca2f90f587683f703d9fb927380c95ec812962d6a907b1298c946ada6`
- `libraries/ExtraArgsCodec.sol`: SHA-256 `4271d34363c4ee6e31d0947bf2ccd527277dde8ec8b328e1cfc420f054362d72`
- `libraries/FinalityCodec.sol`: SHA-256 `63f2946a751b31a8435069fe2cf36aa704d5dd31ec18f42fb41ab9b4fdedba08`

</details>

Hedge uses the [MIT license](LICENSE). Reference: [CCIP best practices](https://docs.chain.link/ccip/evm/concepts/best-practices),
[manual execution](https://docs.chain.link/ccip/evm/tutorials/application-developers/manual-execution),
[Hedera system-contract ABI](https://docs.hedera.com/evm/hedera-services/system-contracts),
[HTS response codes](https://github.com/hiero-ledger/hiero-contracts/blob/main/contracts/common/HederaResponseCodes.sol).
