import { describe, it, expect, vi } from "vitest";
import {
  keccak256,
  encodeEventTopics,
  encodeAbiParameters,
  encodeFunctionData,
  concatHex,
  toHex,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { hedgeLendingAbi } from "@hedge/bindings";
import {
  EvmHedgeReader,
  agreementHash,
  loanId,
  termsHash,
  type EvmLoan,
  tokenAbi,
} from "../src/evm/chain-reader";
import { delegationManager, delegationParameters, redemptionAbi } from "../src/evm/delegated-call";
import { EvmHedgeAdapter, type EvmWallet } from "../src/evm/evm-adapter";
import type { DeploymentManifest } from "@hedge/schema";

const address = (n: string) => `0x${n.repeat(40)}` as Address;
const hash = (n: string) => `0x${n.repeat(64)}` as Hex;
const borrower = address("1"),
  operator = address("2"),
  token = address("3"),
  asset = address("4");
const manifest: DeploymentManifest = {
  schema_version: 1,
  instance_id: hash("1"),
  build_id: "test",
  protocol_version: 3,
  deployer: operator,
  hedera: {
    chain_id: 296,
    router: address("5"),
    selector: "1",
    contract: address("6"),
    code_hash: keccak256("0x6000"),
    contract_id: "0.0.1",
  },
  base: {
    chain_id: 84532,
    router: address("7"),
    selector: "2",
    contract: address("8"),
    code_hash: keccak256("0x6000"),
  },
};
function fixture() {
  const reader = new EvmHedgeReader({
    manifest,
    rpc: { hedera: "http://fixture.invalid", base: "http://fixture.invalid" },
    startBlock: { hedera: 0n, base: 0n },
    resolveAccount: async () => "0.0.2",
  });
  vi.spyOn(reader, "verifyDeployment").mockResolvedValue();
  vi.spyOn(reader, "loanToken").mockResolvedValue(token);
  const id = loanId(manifest.instance_id as Hex, hash("2"));
  const terms = {
    borrower,
    fundingRecipient: borrower,
    principal: 1_000_000n,
    repaymentAmount: 1_020_000n,
    collateralAsset: asset,
    collateralAmount: 2_000_000n,
    collateralOwner: borrower,
    returnRecipient: borrower,
    recoveryRecipient: operator,
    acceptanceDeadline: 2_000_000_000n,
    setupDeadline: 2_000_001_000n,
    duration: 30 * 86400,
    gracePeriod: 0,
    policyHash: hash("3"),
    collateralRepaymentAmount: 0n,
  };
  const agreement: EvmLoan["agreement"] = {
    version: 3,
    instanceId: manifest.instance_id as Hex,
    hederaChainId: 296n,
    baseChainId: 84532n,
    hederaSelector: 1n,
    baseSelector: 2n,
    lending: manifest.hedera.contract as Address,
    vault: manifest.base.contract as Address,
    operator,
    loanToken: token,
    offerId: hash("2"),
    loanId: id,
    terms,
  };
  const loan: EvmLoan = {
    agreement,
    agreementHash: agreementHash(agreement),
    state: 1,
    fundedAt: 0n,
    paymentDeadline: 0n,
  };
  vi.spyOn(reader.clients.hedera, "readContract").mockImplementation(async () => loan as never);
  const wallet: EvmWallet = {
    wallet: async (chain) => ({
      chain_id: manifest[chain].chain_id,
      address: borrower,
      ...(chain === "hedera" ? { account_id: "0.0.2" } : {}),
    }),
    connect: async () => {
      throw new Error("Unexpected connection");
    },
    send: vi.fn(async () => hash("a")),
  };
  const journal = new Map<string, Hex>();
  const relay = vi.fn(async () => undefined);
  const adapter = new EvmHedgeAdapter({
    reader,
    operator,
    wallet,
    journal: {
      get: (key) => journal.get(key),
      set: (key, value) => {
        journal.set(key, value);
      },
    },
    discover: async () => [],
    relay,
  });
  return { reader, loan, id, adapter, wallet, journal, relay };
}
describe("real EVM adapter boundaries", () => {
  it("authorizes collateral repayment, settles Base and waits for the canonical receipt", async () => {
    const f = fixture();
    f.loan.state = 2;
    f.loan.agreement.terms.collateralRepaymentAmount = 1020000n;
    f.loan.agreementHash = agreementHash(f.loan.agreement);
    const custody = { outcome: 0, claimed: false };
    vi.spyOn(f.reader, "custody").mockImplementation(async () => custody as never);
    vi.spyOn(f.reader, "summary").mockResolvedValue({
      state: "repaid",
      collateral_state: "settled",
    } as never);
    const tx = vi.spyOn(f.adapter, "transact").mockImplementation(async (transaction) => {
      if (transaction.chain === "hedera") {
        f.loan.state = 6;
        custody.outcome = 3;
      } else custody.claimed = true;
      return { chain: transaction.chain, hash: hash("a"), confirmed: true };
    });
    f.relay.mockImplementation(async () => {
      if (custody.claimed) f.loan.state = 3;
    });
    await expect(f.adapter.repayWithCollateral(f.id, f.loan.agreementHash)).resolves.toMatchObject({
      state: "repaid",
      collateral_state: "settled",
    });
    expect(tx.mock.calls.map(([tx]) => tx.key)).toEqual([
      `${f.id}-collateral-request`,
      `${f.id}-settle`,
    ]);
    expect(tx.mock.calls.map(([tx]) => tx.chain)).toEqual(["hedera", "base"]);
  });
  it("resumes a completed Base split without paying again while Hedera awaits confirmation", async () => {
    const f = fixture();
    f.loan.state = 6;
    f.loan.agreement.terms.collateralRepaymentAmount = 1020000n;
    f.loan.agreementHash = agreementHash(f.loan.agreement);
    vi.spyOn(f.reader, "custody").mockResolvedValue({ outcome: 3, claimed: true } as never);
    vi.spyOn(f.reader, "summary").mockResolvedValue({
      state: "repaid",
      collateral_state: "settled",
    } as never);
    f.relay.mockImplementation(async () => {
      f.loan.state = 3;
    });
    const tx = vi.spyOn(f.adapter, "transact");
    await f.adapter.resume(f.id);
    expect(tx).not.toHaveBeenCalled();
  });
  it("rejects disabled collateral repayment and an unreviewed agreement", async () => {
    const f = fixture();
    f.loan.state = 2;
    await expect(f.adapter.repayWithCollateral(f.id, f.loan.agreementHash)).rejects.toThrow(
      "not agreed",
    );
    f.loan.agreement.terms.collateralRepaymentAmount = 1020000n;
    f.loan.agreementHash = agreementHash(f.loan.agreement);
    await expect(f.adapter.repayWithCollateral(f.id, hash("f"))).rejects.toThrow("Review");
    expect(f.wallet.send).not.toHaveBeenCalled();
  });
  it("still verifies a v2 loan using its real archived ABI and disables collateral repayment", async () => {
    const f = fixture();
    f.reader.manifest.protocol_version = 2;
    f.loan.agreement.version = 2;
    const id = loanId(manifest.instance_id as Hex, hash("2"), 2);
    f.loan.agreement.loanId = id;
    delete (f.loan.agreement.terms as Partial<EvmLoan["agreement"]["terms"]>)
      .collateralRepaymentAmount;
    f.loan.agreementHash = agreementHash(f.loan.agreement);
    const actual = await f.reader.loan(id);
    expect(actual.agreement.terms.collateralRepaymentAmount).toBe(0n);
    await expect(f.adapter.repayWithCollateral(id, actual.agreementHash)).rejects.toThrow(
      "not agreed",
    );
  });
  it("does not persist a new loan checkpoint when the acceptance wallet prompt is declined", async () => {
    const { adapter, wallet, reader, id, journal } = fixture();
    const checkpoint = vi.fn();
    adapter.options.journal.checkpoint = checkpoint;
    vi.mocked(wallet.send).mockRejectedValue(new Error("User declined"));
    await expect(
      adapter.transact(
        {
          chain: "hedera",
          to: reader.address("hedera"),
          data: "0x1234",
          key: `${id}-accept`,
          label: "Accept loan",
        },
        id,
      ),
    ).rejects.toThrow("User declined");
    expect(checkpoint).not.toHaveBeenCalled();
    expect(journal.size).toBe(0);
  });
  it("awaits durable async journals before attempting canonical confirmation", async () => {
    const f = fixture();
    const confirm = vi.spyOn(f.reader, "confirmed").mockResolvedValue({} as never);
    f.adapter.options.journal.set = async () => {
      throw new Error("Database unavailable");
    };
    await expect(
      f.adapter.transact({
        chain: "hedera",
        to: token,
        data: "0x1234",
        key: "test",
        label: "test",
      }),
    ).rejects.toThrow("Database unavailable");
    expect(confirm).not.toHaveBeenCalled();
  });
  it("recovers loans from canonical accepted events and excludes only completed collateral outcomes", async () => {
    const f = fixture();
    const log = {
      data: encodeAbiParameters([{ type: "bytes32" }], [f.loan.agreementHash]),
      topics: encodeEventTopics({
        abi: hedgeLendingAbi,
        eventName: "LoanAccepted",
        args: { loanId: f.id, offerId: hash("2") },
      }),
    };
    vi.spyOn(f.reader, "logs").mockResolvedValue([log, log] as Awaited<
      ReturnType<EvmHedgeReader["logs"]>
    >);
    vi.spyOn(f.reader, "loan").mockResolvedValue(f.loan);
    const summary = {
      instance_id: manifest.instance_id,
      credit_id: f.id,
      agreement_hash: f.loan.agreementHash,
      state: "accepted" as const,
      collateral_state: "unlocked" as const,
      amount_due: 0n,
      payment_deadline: null,
    };
    const current = vi.spyOn(f.reader, "summary").mockResolvedValue(summary);
    expect(await f.adapter.outstandingLoans(borrower)).toEqual([f.id]);
    expect(await f.adapter.outstandingLoans(operator)).toEqual([]);
    current.mockResolvedValue({ ...summary, state: "repaid", collateral_state: "return_pending" });
    expect(await f.adapter.outstandingLoans(borrower)).toEqual([f.id]);
    current.mockResolvedValue({ ...summary, state: "repaid", collateral_state: "returned" });
    expect(await f.adapter.outstandingLoans(borrower)).toEqual([]);
    current.mockResolvedValue({ ...summary, state: "defaulted", collateral_state: "recovered" });
    expect(await f.adapter.outstandingLoans(borrower)).toEqual([]);
    current.mockResolvedValue({ ...summary, state: "cancelled", collateral_state: "unlocked" });
    expect(await f.adapter.outstandingLoans(borrower)).toEqual([]);
  });
  it("coalesces concurrent reads but rereads mutable canonical state on the next call", async () => {
    const { reader, loan, id } = fixture();
    const read = vi.mocked(reader.clients.hedera.readContract);
    await Promise.all([reader.loan(id), reader.loan(id)]);
    expect(read).toHaveBeenCalledTimes(1);
    loan.state = 2;
    expect((await reader.loan(id)).state).toBe(2);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("waits for stable canonical block and receipt hashes after a changed observation", async () => {
    const { reader } = fixture();
    vi.useFakeTimers();
    const a = { status: "success", blockNumber: 10n, blockHash: hash("a") },
      b = { ...a, blockHash: hash("b") };
    const receipts = vi
      .spyOn(reader.clients.base, "getTransactionReceipt")
      .mockResolvedValueOnce(a as never)
      .mockResolvedValueOnce(a as never)
      .mockResolvedValue(b as never);
    vi.spyOn(reader.clients.base, "getBlockNumber").mockResolvedValue(20n);
    vi.spyOn(reader.clients.base, "getBlock").mockResolvedValue({ hash: hash("b") } as never);
    const pending = reader.confirmed("base", hash("c"));
    await vi.advanceTimersByTimeAsync(2000);
    expect((await pending).blockHash).toBe(hash("b"));
    expect(receipts).toHaveBeenCalledTimes(4);
    vi.useRealTimers();
  });
  it("never reports a reverted transaction as confirmed", async () => {
    const { reader } = fixture();
    vi.spyOn(reader.clients.hedera, "getTransactionReceipt").mockResolvedValue({
      status: "reverted",
    } as never);
    await expect(reader.confirmed("hedera", hash("c"))).rejects.toMatchObject({
      code: "TRANSACTION_REVERTED",
    });
  });
  it("rejects a destination marker for a different CCIP payload", async () => {
    const { reader, id } = fixture();
    vi.spyOn(reader.clients.base, "readContract").mockImplementation(
      async ({ functionName }) =>
        (functionName === "operationId"
          ? hash("a")
          : { payload: "0x1234", lastMessageId: hash("b"), submissions: 1n }) as never,
    );
    vi.spyOn(reader.clients.hedera, "readContract").mockResolvedValue(hash("f") as never);
    await expect(reader.outbox(id, 1)).rejects.toMatchObject({ code: "MESSAGE_MISMATCH" });
  });
  it("rejects a changed canonical agreement hash", async () => {
    const { reader, loan, id } = fixture();
    loan.agreementHash = hash("f");
    await expect(reader.loan(id)).rejects.toMatchObject({ code: "AGREEMENT_MISMATCH" });
  });
  it.each(["vault", "lending", "instanceId", "loanId"] as const)(
    "rejects a wrong %s binding even with a recomputed hash",
    async (field) => {
      const { reader, loan, id } = fixture();
      Object.assign(loan.agreement, {
        [field]: field === "instanceId" || field === "loanId" ? hash("f") : address("f"),
      });
      loan.agreementHash = agreementHash(loan.agreement);
      await expect(reader.loan(id)).rejects.toMatchObject({ code: "AGREEMENT_MISMATCH" });
    },
  );
  it("checks canonical offer hashing including policy", async () => {
    const { reader, loan } = fixture(),
      a = loan.agreement;
    const hashed = termsHash(a.instanceId, a.offerId, token, a.terms, a.operator);
    expect((await reader.projectOffer(a.offerId, a.terms, hashed, a.operator)).policy_hash).toBe(
      a.terms.policyHash,
    );
    await expect(
      reader.projectOffer(
        a.offerId,
        { ...a.terms, repaymentAmount: 2_000_000n },
        hashed,
        a.operator,
      ),
    ).rejects.toMatchObject({ code: "OFFER_MISMATCH" });
  });
  it("checks Base authorization against the Hedera agreement", async () => {
    const { reader, loan, id } = fixture();
    vi.spyOn(reader, "custody").mockResolvedValue({
      agreement: loan.agreement,
      agreementHash: hash("f"),
      authorized: true,
      locked: true,
      claimed: false,
      outcome: 0,
    });
    await expect(reader.summary(id)).rejects.toMatchObject({ code: "AGREEMENT_MISMATCH" });
  });
  it("does not report a state-only payout as confirmed funding", async () => {
    const { reader, loan, adapter, id } = fixture();
    loan.state = 2;
    loan.fundedAt = 100n;
    loan.paymentDeadline = 200n;
    vi.spyOn(reader.clients.hedera, "getBlockNumber").mockResolvedValue(10n);
    vi.spyOn(reader, "logs").mockResolvedValue([]);
    await expect(adapter.funding(id)).rejects.toMatchObject({ code: "FUNDING_PENDING" });
  });
  it("resumes the saved transaction hash after a confirmation timeout", async () => {
    const { adapter, reader, wallet, id } = fixture();
    const confirmed = vi
      .spyOn(reader, "confirmed")
      .mockRejectedValueOnce(new Error("RPC timeout"))
      .mockResolvedValue({ status: "success" } as never);
    const tx = {
      chain: "hedera" as const,
      to: reader.address("hedera"),
      data: "0x12345678" as Hex,
      key: `${id}-accept`,
      label: "Accept loan",
    };
    vi.spyOn(reader.clients.hedera, "getTransaction").mockResolvedValue({
      to: tx.to,
      from: borrower,
      input: tx.data,
      value: 0n,
    } as never);
    await expect(adapter.transact(tx, id)).rejects.toMatchObject({
      code: "PENDING",
      checkpoint: { credit_id: id },
    });
    expect((await adapter.transact(tx, id)).hash).toBe(hash("a"));
    expect(wallet.send).toHaveBeenCalledTimes(1);
    expect(confirmed.mock.calls[0][1]).toBe(confirmed.mock.calls[1][1]);
  });
  it("rejects a journal hash that belongs to another successful transaction", async () => {
    const { adapter, reader, id, journal, wallet } = fixture();
    journal.set(`${manifest.instance_id}:hedera:${id}-repay`, hash("a"));
    vi.spyOn(reader, "confirmed").mockResolvedValue({ status: "success" } as never);
    vi.spyOn(reader.clients.hedera, "getTransaction").mockResolvedValue({
      to: address("f"),
      from: borrower,
      input: "0x12345678",
      value: 0n,
    } as never);
    await expect(
      adapter.transact(
        {
          chain: "hedera",
          to: reader.address("hedera"),
          data: "0x12345678",
          key: `${id}-repay`,
          label: "Repay",
        },
        id,
      ),
    ).rejects.toMatchObject({ code: "TRANSACTION_MISMATCH" });
    expect(wallet.send).not.toHaveBeenCalled();
  });
  it("recovers a saved sponsored approval without broadcasting again, and still rejects a different root wallet", async () => {
    const { adapter, reader, id, journal, wallet } = fixture();
    const vault = reader.address("base");
    const tx = {
      chain: "base" as const,
      to: asset,
      data: encodeFunctionData({
        abi: tokenAbi,
        functionName: "approve",
        args: [vault, 2_000_000n],
      }),
      key: `${id}-collateral-approve`,
      label: "Approve collateral",
    };
    journal.set(`${manifest.instance_id}:base:${tx.key}`, hash("a"));
    const abi = parseAbi([
      "event Approval(address indexed owner,address indexed spender,uint256 value)",
    ]);
    vi.spyOn(reader, "confirmed").mockResolvedValue({
      status: "success",
      logs: [
        {
          address: asset,
          topics: encodeEventTopics({
            abi,
            eventName: "Approval",
            args: { owner: borrower, spender: vault },
          }),
          data: encodeAbiParameters([{ type: "uint256" }], [2_000_000n]),
        },
      ],
    } as never);
    vi.spyOn(reader.clients.base, "readContract").mockResolvedValue(asset as never);
    const input = (root: Address) =>
      encodeFunctionData({
        abi: redemptionAbi,
        functionName: "redeemDelegations",
        args: [
          [
            encodeAbiParameters(delegationParameters, [
              [
                {
                  delegate: address("9"),
                  delegator: root,
                  authority: hash("f"),
                  caveats: [],
                  salt: 0n,
                  signature: "0x12",
                },
              ],
            ]),
          ],
          [hash("0")],
          [concatHex([asset, toHex(0n, { size: 32 }), tx.data])],
        ],
      });
    const observed = vi.spyOn(reader.clients.base, "getTransaction").mockResolvedValue({
      to: delegationManager,
      from: address("9"),
      input: input(borrower),
      value: 0n,
    } as never);
    expect(await adapter.transact(tx, id)).toEqual({
      chain: "base",
      hash: hash("a"),
      confirmed: true,
    });
    observed.mockResolvedValue({
      to: delegationManager,
      from: address("9"),
      input: input(operator),
      value: 0n,
    } as never);
    await expect(adapter.transact(tx, id)).rejects.toMatchObject({ code: "TRANSACTION_MISMATCH" });
    expect(wallet.send).not.toHaveBeenCalled();
    expect(journal.get(`${manifest.instance_id}:base:${tx.key}`)).toBe(hash("a"));
  });
  it("rejects mismatched wallet/account identities before sending", async () => {
    const { adapter, wallet } = fixture();
    vi.spyOn(wallet, "wallet").mockResolvedValue({
      chain_id: 296,
      address: borrower,
      account_id: "0.0.999",
    });
    await expect(adapter.identity("hedera", borrower)).rejects.toMatchObject({
      code: "WALLET_MISMATCH",
    });
    expect(wallet.send).not.toHaveBeenCalled();
  });
  it("does not claim collateral while canonical delivery is pending", async () => {
    const { adapter, reader, loan, id, wallet } = fixture();
    loan.state = 3;
    vi.spyOn(reader, "custody").mockResolvedValue({
      agreement: loan.agreement,
      agreementHash: loan.agreementHash,
      authorized: true,
      locked: true,
      claimed: false,
      outcome: 0,
    });
    await expect(adapter.claimCollateral(id)).rejects.toMatchObject({ code: "PENDING" });
    expect(wallet.send).not.toHaveBeenCalled();
  });
});

describe("shared deployment operator bindings", () => {
  it("reads a canonical loan issued by a different operator than the deployer", async () => {
    const { reader, loan, id } = fixture();
    loan.agreement.operator = address("9");
    loan.agreementHash = agreementHash(loan.agreement);
    expect((await reader.loan(id)).agreement.operator).toBe(address("9"));
    loan.agreement.operator = address("0");
    loan.agreementHash = agreementHash(loan.agreement);
    await expect(reader.loan(id)).rejects.toMatchObject({ code: "AGREEMENT_MISMATCH" });
  });
  it("binds the reviewed offer hash to its operator", async () => {
    const { reader, loan } = fixture();
    const a = loan.agreement;
    const hash = termsHash(a.instanceId, a.offerId, token, a.terms, a.operator);
    await expect(reader.projectOffer(a.offerId, a.terms, hash, address("9"))).rejects.toMatchObject(
      { code: "OFFER_MISMATCH" },
    );
  });
  it("checks loan ownership before requesting a default or recovery signature", async () => {
    const { adapter, wallet, id } = fixture();
    await expect(adapter.authorizeDefault(borrower, id)).rejects.toMatchObject({
      code: "OPERATOR_MISMATCH",
    });
    await expect(adapter.claimRecovery(borrower, id)).rejects.toMatchObject({
      code: "OPERATOR_MISMATCH",
    });
    expect(wallet.send).not.toHaveBeenCalled();
  });
});
