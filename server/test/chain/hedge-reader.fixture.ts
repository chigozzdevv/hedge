import { vi } from "vitest";
import type { DeploymentManifest, Offer, CreditSummary } from "@hedge/schema";
import type { HedgeReader } from "../../src/shared/chain/hedge.client.js";
import type { ChainObservation } from "../../src/shared/chain/chain.schema.js";
import type { CollateralSummary } from "../../src/shared/chain/hedge.schema.js";
export const address = `0x${"1".repeat(40)}`;
export const hash = `0x${"2".repeat(64)}`;
export const manifest: DeploymentManifest = {
  schema_version: 1,
  instance_id: "fixture",
  build_id: "unit-test",
  protocol_version: 3,
  deployer: address,
  hedera: {
    chain_id: 296,
    router: address,
    selector: "1",
    contract: address,
    code_hash: hash,
    contract_id: "0.0.123",
  },
  base: { chain_id: 84532, router: address, selector: "2", contract: address, code_hash: hash },
};
export const funding = {
  token: address,
  amount: 1000000n,
  recipient: { account_id: "0.0.456", address },
};
export const offer: Offer = {
  id: "offer-1",
  instance_id: "fixture",
  terms_hash: hash,
  operator: address,
  funding,
  repayment_amount: 1010000n,
  acceptance_deadline: 2000000000,
  setup_deadline: 2000000300,
  duration: 86400,
  grace_period: 0,
  collateral: {
    asset: address,
    amount: 2000000n,
    owner: address,
    return_recipient: address,
    recovery_recipient: address,
  },
};
export const credit: CreditSummary = {
  instance_id: "fixture",
  credit_id: "loan-1",
  agreement_hash: hash,
  state: "funded",
  collateral_state: "locked",
  amount_due: 1010000n,
  payment_deadline: 2000086400,
};
export const collateral: CollateralSummary = {
  instance_id: "fixture",
  credit_id: "loan-1",
  agreement_hash: hash,
  lock_id: "lock-1",
  asset: address,
  amount: 2000000n,
  owner: address,
  return_recipient: address,
  recovery_recipient: address,
  state: "locked",
};
export function observed<T>(data: T, chain: "hedera" | "base" = "hedera"): ChainObservation<T> {
  return {
    data,
    chainId: manifest[chain].chain_id,
    contract: address,
    observedBlock: 100,
    observedHash: hash,
  };
}
export function makeReader(overrides: Partial<HedgeReader> = {}): HedgeReader {
  return {
    verifyDeployment: vi.fn(async () => {}),
    offers: vi.fn(async () => [observed(offer)]),
    offer: vi.fn(async () => observed(offer)),
    credit: vi.fn(async () => observed(credit)),
    collateral: vi.fn(async () => observed(collateral, "base")),
    operator: vi.fn(async () =>
      observed({
        instance_id: "fixture",
        operator: address,
        token: address,
        free_capital: 10000000n,
        reserved_capital: 1000000n,
      }),
    ),
    ...overrides,
  };
}
