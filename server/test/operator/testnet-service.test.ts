import { testRecord, testConfig } from "../../../packages/schema/test/config-fixture.js";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  type Address,
} from "viem";
import { hedgeLendingAbi, hedgeVaultAbi } from "@hedge/bindings";
import { tokenAbi, type EvmTransaction } from "@hedge/sdk";
import { privateKeyToAccount } from "viem/accounts";
import { compileQuotePolicy } from "../../src/features/operator/quote-policy.js";
import { createOperatorRuntime } from "../../src/features/operator/operator-runtime.js";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  send: vi.fn(),
  offer: vi.fn(),
  loan: vi.fn(),
  logs: vi.fn(),
  outstanding: vi.fn(),
}));
vi.mock("@hedge/sdk", async (original) => {
  const actual = await original<typeof import("@hedge/sdk")>();
  return {
    ...actual,
    createAccountResolver: () => async () => "0.0.123",
    EvmHedgeReader: class {
      constructor(
        readonly config: { manifest: { hedera: { contract: string }; base: { contract: string } } },
      ) {}
      lendingAbi = hedgeLendingAbi;
      vaultAbi = hedgeVaultAbi;
      clients = {
        base: { readContract: mocks.read },
        hedera: {
          getCode: async () => "0x6000",
          getBlock: async () => ({ timestamp: 1000n }),
          readContract: mocks.read,
        },
      };
      verifyDeployment = async () => undefined;
      loanToken = async () => "0x0000000000000000000000000000000000001549";
      address(chain: "hedera" | "base") {
        return this.config.manifest[chain].contract;
      }
      confirmed = async () => undefined;
      logs = mocks.logs;
      offer = mocks.offer;
      loan = mocks.loan;
      outstandingLoans = mocks.outstanding;
    },
  };
});
vi.mock("../../src/shared/chain/local-signer.js", () => ({
  LocalTestSigner: class {
    send = mocks.send;
  },
}));
vi.mock("../../src/features/credit/ccip-relay.js", () => ({
  createCcipRelay: () => async () => undefined,
}));

const record = structuredClone(testRecord);
const baseKey = `0x${"12".repeat(32)}` as const;
const hederaKey = `0x${"34".repeat(32)}` as const;
const local = privateKeyToAccount(baseKey).address;
const signerAddress = privateKeyToAccount(hederaKey).address;
const defaults = {
  loan_asset: {
    chain_id: 296,
    symbol: "USDC",
    address: "0x0000000000000000000000000000000000001549",
  },
  accepted_collateral: {
    chain_id: 84532,
    symbol: "USDC",
    address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  },
  max_loan_amount: "1",
  collateral_ratio: "2",
  financing_charge_percent: "2",
  term_days: 30,
  eligible_borrowers: [local],
};
const other = `0x${"2".repeat(40)}` as Address;
const loanId = `0x${"3".repeat(64)}` as const;
const hash = `0x${"4".repeat(64)}` as const;
const collateral = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
let root: string;
beforeEach(() => {
  vi.clearAllMocks();
  for (const name of [
    "HEDGE_POLICY_FILE",
    "HEDGE_DEPLOYMENT_FILE",
    "HEDGE_OPERATOR_URL",
    "HEDGE_OPERATOR_ADDRESS",
  ])
    vi.stubEnv(name, undefined);
  root = mkdtempSync(join(tmpdir(), "hedge-operator-service-"));
  for (const path of ["deployments", ".hedge"]) mkdirSync(join(root, path));
  writeFileSync(join(root, "deployments/testnet.json"), JSON.stringify(record));
  writeFileSync(
    join(root, ".hedge/hedge.config.json"),
    JSON.stringify({
      deployment_file: "deployments/testnet.json",
      operator: signerAddress,
      operator_url: testConfig.operator_url,
      rpc: testConfig.rpc,
      mirror_url: testConfig.mirror_url,
    }),
  );
  writeFileSync(
    join(root, ".hedge/wallets.json"),
    JSON.stringify({
      hedera: { address: signerAddress, private_key: hederaKey },
      base: { address: local, private_key: baseKey },
    }),
    { mode: 0o600 },
  );
  mocks.logs.mockResolvedValue([]);
  mocks.outstanding.mockResolvedValue([]);
  mocks.read.mockImplementation(async ({ functionName }) => {
    if (functionName === "offerNonce") return 0n;
    if (functionName === "collateralAsset") return collateral;
    throw new Error("Unexpected contract read");
  });
  mocks.send.mockResolvedValue(hash);
  mocks.offer.mockResolvedValue({ funding: { amount: 3_000_000n } });
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
async function service(change: Record<string, unknown> = {}) {
  writeFileSync(join(root, ".hedge/operator.json"), JSON.stringify({ ...defaults, ...change }));
  return createOperatorRuntime(root, undefined, { localWallet: true });
}
async function publicService() {
  const configPath = join(root, ".hedge/hedge.config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.operator_url = "https://operator.example/operator";
  writeFileSync(configPath, JSON.stringify(config));
  writeFileSync(join(root, ".hedge/operator.json"), JSON.stringify(defaults));
  return createOperatorRuntime(root);
}
const request = (amount: bigint, address = local) => ({
  funding: {
    token: "0x0000000000000000000000000000000000001549",
    amount,
    recipient: { address, account_id: "0.0.123" },
  },
});
function acceptedTerms() {
  return {
    borrower: local,
    fundingRecipient: local,
    ...compileQuotePolicy(defaults).quote(1_000_000n),
    collateralAsset: collateral,
    collateralOwner: local,
    returnRecipient: local,
    recoveryRecipient: signerAddress as Address,
    acceptanceDeadline: 2800n,
    setupDeadline: 4600n,
  };
}
function approval(
  chain: "base" | "hedera",
  amount: bigint,
  kind: "collateral" | "repayment",
): EvmTransaction {
  return {
    chain,
    to: chain === "base" ? collateral : "0x0000000000000000000000000000000000001549",
    data: encodeFunctionData({
      abi: tokenAbi,
      functionName: "approve",
      args: [record.deployment[chain].contract, amount],
    }),
    key: `${record.deployment.instance_id}:${chain}:${loanId}-${kind}-approve`,
    label: "Approve agreed loan amount",
  };
}

describe("configured loopback quote and signing service", () => {
  it("public metadata excludes local borrower credentials and server signing is disabled", async () => {
    const operator = await publicService();
    expect(operator.publicProfile.mode).toBe("wallet");
    expect(operator.publicProfile).not.toHaveProperty("session");
    expect(operator.publicProfile).not.toHaveProperty("borrower");
    await expect(operator.send(approval("hedera", 100n, "repayment"))).rejects.toThrow("disabled");
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("public relays refuse loans belonging to another operator", async () => {
    const operator = await publicService();
    mocks.loan.mockResolvedValue({ agreement: { operator: other } });
    await expect(operator.relay(loanId)).rejects.toThrow("another operator");
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("requires the public collateral wallet to hold the agreed amount before publishing", async () => {
    const operator = await publicService();
    mocks.read.mockResolvedValue(0n);
    await expect(operator.discover(request(100000n), local)).rejects.toThrow("required collateral");
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("refuses assets that differ from the selected contracts before publishing", async () => {
    await expect(service({ loan_asset: { ...defaults.loan_asset, chain_id: 1 } })).rejects.toThrow(
      "must match",
    );
    await expect(
      service({ accepted_collateral: { ...defaults.accepted_collateral, address: other } }),
    ).rejects.toThrow("must match");
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("publishes the configured terms through the actual contract ABI", async () => {
    const operator = await service({
      max_loan_amount: "5",
      collateral_ratio: "1.5",
      financing_charge_percent: "1.25",
      term_days: 7,
    });
    expect(operator.profile.policy).toEqual({ max_loan_amount: "5" });
    await operator.discover(request(3_000_000n), local);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    const [tx, borrowerSigning] = mocks.send.mock.calls[0];
    const call = decodeFunctionData({ abi: hedgeLendingAbi, data: tx.data });
    expect(call.functionName).toBe("publishOffer");
    if (call.functionName !== "publishOffer") throw new Error("Wrong operation");
    expect(call.args[0]).toMatchObject({
      principal: 3_000_000n,
      collateralAmount: 4_500_000n,
      repaymentAmount: 3_037_500n,
      duration: 7 * 86400,
    });
    expect(borrowerSigning).toBe(false);
  });
  it("enforces configured eligibility and limits before spending operator gas", async () => {
    const operator = await service({ eligible_borrowers: [other] });
    await expect(operator.discover(request(100_000n), local)).rejects.toThrow("policy");
    expect(mocks.send).not.toHaveBeenCalled();
    const limited = await service({ max_loan_amount: "0.1" });
    await expect(limited.discover(request(100_001n), local)).rejects.toThrow("policy");
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("publishes for an independent borrower and Base wallet without granting test signing access", async () => {
    const operator = await service({ eligible_borrowers: [] });
    mocks.offer.mockResolvedValue({ funding: { amount: 100_000n } });
    await operator.discover(request(100_000n, other), local);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    const [tx, borrowerSigning] = mocks.send.mock.calls[0];
    const call = decodeFunctionData({ abi: hedgeLendingAbi, data: tx.data });
    if (call.functionName !== "publishOffer") throw new Error("Wrong operation");
    expect(call.args[0]).toMatchObject({
      borrower: other,
      fundingRecipient: other,
      collateralOwner: local,
      returnRecipient: local,
    });
    expect(borrowerSigning).toBe(false);
    mocks.read.mockResolvedValue({
      state: 1,
      operator: signerAddress,
      terms: call.args[0],
      termsHash: hash,
    });
    await expect(
      operator.send({
        chain: "hedera",
        to: record.deployment.hedera.contract,
        data: encodeFunctionData({
          abi: hedgeLendingAbi,
          functionName: "accept",
          args: [loanId, hash],
        }),
        key: `${record.deployment.instance_id}:hedera:${loanId}-accept`,
        label: "Accept borrower offer",
      }),
    ).rejects.toThrow("Unapproved test offer");
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });
  it("rejects a mismatched Hedera account ID before publishing", async () => {
    const operator = await service({ eligible_borrowers: [] });
    const wanted = request(100_000n, other);
    wanted.funding.recipient.account_id = "0.0.999";
    await expect(operator.discover(wanted, local)).rejects.toThrow("does not match");
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("allows a listed independent borrower and rejects a zero collateral owner", async () => {
    const operator = await service({ eligible_borrowers: [other] });
    mocks.offer.mockResolvedValue({ funding: { amount: 100_000n } });
    await expect(
      operator.discover(request(100_000n, other), `0x${"0".repeat(40)}`),
    ).rejects.toThrow("policy");
    expect(mocks.send).not.toHaveBeenCalled();
    await operator.discover(request(100_000n, other), local);
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });
  it("preserves other borrowers' open offers when publishing a new quote", async () => {
    mocks.logs.mockResolvedValue([
      {
        topics: encodeEventTopics({
          abi: hedgeLendingAbi,
          eventName: "OfferPublished",
          args: { offerId: loanId, operator: signerAddress as Address },
        }),
        data: encodeAbiParameters([{ type: "bytes32" }], [hash]),
      },
    ]);
    mocks.read.mockImplementation(async ({ functionName }) =>
      functionName === "collateralAsset"
        ? collateral
        : functionName === "getOffer"
          ? { state: 1, operator: signerAddress, terms: acceptedTerms() }
          : 1n,
    );
    mocks.offer.mockResolvedValue({ funding: { amount: 100_000n } });
    const operator = await service({ eligible_borrowers: [] });
    await operator.discover(request(100_000n, other), other);
    expect(
      mocks.send.mock.calls.map(
        ([tx]) => decodeFunctionData({ abi: hedgeLendingAbi, data: tx.data }).functionName,
      ),
    ).toEqual(["publishOffer"]);
  });
  it("preserves another operator's offer for the same borrower and Base wallet", async () => {
    mocks.logs.mockResolvedValue([
      {
        topics: encodeEventTopics({
          abi: hedgeLendingAbi,
          eventName: "OfferPublished",
          args: { offerId: loanId, operator: other },
        }),
        data: encodeAbiParameters([{ type: "bytes32" }], [hash]),
      },
    ]);
    mocks.read.mockImplementation(async ({ functionName }) =>
      functionName === "collateralAsset"
        ? collateral
        : functionName === "getOffer"
          ? { state: 1, operator: other, terms: acceptedTerms() }
          : 0n,
    );
    mocks.offer.mockResolvedValue({ funding: { amount: 1_000_000n } });
    const own = await service();
    await own.discover(request(1_000_000n), local);
    expect(
      mocks.send.mock.calls.map(
        ([tx]) => decodeFunctionData({ abi: hedgeLendingAbi, data: tx.data }).functionName,
      ),
    ).toEqual(["publishOffer"]);
  });
  it("withdraws a stale open quote before publishing newly configured terms", async () => {
    mocks.logs.mockResolvedValue([
      {
        topics: encodeEventTopics({
          abi: hedgeLendingAbi,
          eventName: "OfferPublished",
          args: { offerId: loanId, operator: signerAddress as Address },
        }),
        data: encodeAbiParameters([{ type: "bytes32" }], [hash]),
      },
    ]);
    mocks.read.mockImplementation(async ({ functionName }) =>
      functionName === "collateralAsset"
        ? collateral
        : functionName === "getOffer"
          ? { state: 1, operator: signerAddress, terms: acceptedTerms() }
          : 0n,
    );
    mocks.offer.mockResolvedValue({ funding: { amount: 1_000_000n } });
    const operator = await service({ financing_charge_percent: "3" });
    await operator.discover(request(1_000_000n), local);
    const operations = mocks.send.mock.calls.map(
      ([tx]) => decodeFunctionData({ abi: hedgeLendingAbi, data: tx.data }).functionName,
    );
    expect(operations).toEqual(["withdrawOffer", "publishOffer"]);
  });
  it("keeps old collateral and repayment approvals valid after lowering limits or removing eligibility", async () => {
    const operator = await service({
      max_loan_amount: "0.1",
      collateral_ratio: "1",
      financing_charge_percent: "0",
      term_days: 7,
      eligible_borrowers: [other],
    });
    const old = acceptedTerms();
    mocks.loan.mockResolvedValue({ state: 1, agreement: { terms: old } });
    await expect(operator.send(approval("base", 2_000_000n, "collateral"))).resolves.toBe(hash);
    mocks.loan.mockResolvedValue({ state: 2, agreement: { terms: old } });
    await expect(operator.send(approval("hedera", 1_020_000n, "repayment"))).resolves.toBe(hash);
    expect(mocks.send).toHaveBeenCalledTimes(2);
    await expect(operator.send(approval("hedera", 1_020_001n, "repayment"))).rejects.toThrow(
      "approval",
    );
    mocks.loan.mockResolvedValue({ state: 2, agreement: { terms: { ...old, borrower: other } } });
    await expect(operator.send(approval("hedera", 1_020_000n, "repayment"))).rejects.toThrow(
      "approval",
    );
    expect(mocks.send).toHaveBeenCalledTimes(2);
  });
  it("reconciles a consumed acceptance after policy changes but rejects new or mismatched acceptance", async () => {
    const operator = await service({ max_loan_amount: "0.1", eligible_borrowers: [other] });
    const tx: EvmTransaction = {
      chain: "hedera",
      to: record.deployment.hedera.contract,
      data: encodeFunctionData({
        abi: hedgeLendingAbi,
        functionName: "accept",
        args: [loanId, hash],
      }),
      key: `${record.deployment.instance_id}:hedera:${loanId}-accept`,
      label: "Accept agreed offer",
    };
    const consumed = {
      state: 2,
      operator: signerAddress,
      terms: acceptedTerms(),
      termsHash: hash,
    };
    mocks.read.mockResolvedValue(consumed);
    await expect(operator.send(tx)).resolves.toBe(hash);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    mocks.read.mockResolvedValue({ ...consumed, state: 1 });
    await expect(operator.send(tx)).rejects.toThrow("Unapproved test offer");
    mocks.read.mockResolvedValue({ ...consumed, termsHash: loanId });
    await expect(operator.send(tx)).rejects.toThrow("Unapproved test offer");
    mocks.read.mockResolvedValue({ ...consumed, state: 3 });
    await expect(operator.send(tx)).rejects.toThrow("Unapproved test offer");
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });
});
