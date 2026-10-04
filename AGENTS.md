# Hedge repository instructions

Read the protocol rules in `README.md` before changing loan behavior. This repository contains locally
tested contracts, a real EVM SDK and recorded local testnet integration evidence, not a production
lending protocol. Maintain that distinction in code,
documentation, examples and generated output.

## Ownership and layout

- `packages/foundry`: Foundry Solidity, Hedera lending and Base custody. All contracts use EVM; no additional runtime folder is needed.
- `packages/schema`: shared runtime validation and inferred boundary types.
- `packages/bindings`: explicit contract registry and generated ABIs; codegen stays here.
- `packages/sdk`: public factory, resource handles, progress/errors and adapter boundary.
- `packages/nextjs` owns the Next.js website and working swap reference at `/demo`, including
  host wallet/DEX services and swap recovery. It consumes the public frontend package.
- `packages/frontend` owns the reusable Hedge provider and Use Hedge modal.
  React apps use `HedgeProvider`/`UseHedge`; on first use the provider loads supplied public config,
  verifies contracts and mounts one modal. Keep low-level factory/adapter wiring internal
  to that integration. Wallet/session credentials never enter public config.
  Contracts isolate capital/reservations/offers by each app operator. The deployer
  only freezes peers; it cannot administer another operator’s capital or loans.
  Public config selects the app operator independently of the shared deployment.
  App `.hedge/operator.json` owns quoting rules; an empty borrower list leaves eligibility open.
  App `.hedge/hedge.config.json` ships with the scaffold and is operator-editable. Startup reads and
  verifies it without overwriting it; explicit deployment updates deployments/testnet.json.
  The reference app serves that same file at
  `/hedge.config.json`. Do not generate another copy in its public folder.
  Quotes bind each connected Hedera borrower and Base owner; relay uses verified instance
  agreements. Generated borrower keys are only for the optional local test signer.
  The demo injects real services in explicit loopback testnet mode; reusable
  components still require real wallet/chain services. Browser extension/native wallet
  integrations and production services are not live-verified.
  `.hedge` belongs to the host app (`packages/nextjs/.hedge` here), never the repository root.
  It contains only wallets.json, operator.json and hedge.config.json. `init` creates/reuses
  wallets and binds the supplied public settings to their operator on first initialization.
  Signing recovery, confirmed liquidity receipts, process state and logs persist in configured
  MongoDB/PostgreSQL; commands fail before signing when storage is unavailable.
- `server/src/features`: intent/offer/credit/collateral/operator modules and their controller,
  schema, service, route and index files. Persistent features own model/repo files;
  credit/collateral workers stay in their feature folders.
- `server/src/shared`: reusable config, database, chain, HTTP, logging and queue code.
  Shared code must not import feature modules. Cross-feature chain data schemas
  live in `shared/chain`; feature request schemas stay with their feature.
- `server/src/app.ts` wires feature routes and services; `server.ts` starts the process.
  Packages never depend on the server.

Keep one README at the repository root. Contract policy, server setup, test coverage
and vendored dependency provenance belong there; do not add nested README files.

Use clear kebab-case filenames, at most two words where practical. Keep Solidity
types PascalCase. Keep `create_hedge` as the only client factory; preserve `intent()`/`credit(id)` and
resource handles. Do not reintroduce restricted purchase accounts, pooled LP
shares, application execution registration, portfolio liquidation or old chains.

## Implementation rules

Hedera owns the canonical loan outcome; Base enforces the agreed pledge. Do not
add competing timeout releases. Deployed contracts and accepted agreements own
authority. A manifest, browser checkpoint, backend or adapter cannot replace it.
Never report submitted transactions or mock delivery as confirmed funding/claims.
Keep loan payout, app action, repayment and collateral return separate.

Do not fabricate ABIs, deployments, testnet evidence or scaffold capability flags.
Register real artifacts in `packages/bindings/contracts.json`, generate and check
them. Lending/custody contracts, codecs, the EVM adapter, deployment scripts and
local testnet browser happy path are implemented. Broader live recovery and
production wallet/operator integrations remain pending. Contract tests must cover the full lifecycle,
message/token failure recovery and adversarial operation sequences. Keep vendored
consumer interfaces unchanged and preserve their provenance/checksums.
Do not edit the original Termbook checkout.

## Commands

Node 20.19+, 22.13+, or 24+, npm and Foundry are required. Run `npm ci`, `npm run build:contracts`, `npm run codegen`, then
`npm run check`. The initial compiler download needs network access. Use
`npm run build:packages` for TypeScript-only work. `npm run check` builds packages
before typechecking/testing because workspace imports resolve built outputs. The
server is included in workspace checks; `npm run dev:server` starts its HTTP
foundation. `/ready` checks infrastructure only. Do not claim live loan/index/CCIP
readiness from that endpoint. The generic protocol reader is not configured by the normal CLI;
protocol reads fail explicitly. Feature workers require explicit registration.

Do not commit keys. `.hedge/wallets.json` contains actual private keys, generated by `init`,
and must have permissions 0600. Never serve it, log its contents or include it in public config.
Wallet passwords and Keychain are not part of the setup. Public manifests carry identities
and public evidence only.
