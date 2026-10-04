import { describe, expect, it } from "vitest";
import {
  concatHex,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  keccak256,
  parseAbi,
  parseAbiParameters,
  toHex,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { hedgeVaultAbi } from "@hedge/bindings";
import settlement from "./fixtures/sponsored-settlement.json";
import { tokenAbi } from "../src/evm/chain-reader";
import {
  delegationManager,
  delegationParameters,
  matchesDelegatedCall,
  redemptionAbi,
} from "../src/evm/delegated-call";

const owner: Address = "0x5982db33477d3085d10703d0086d144307923431";
const relayer: Address = "0xc066ac5d385419b1a8c43a0e146fa439837a8b8c";
const token: Address = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
const vault: Address = "0xb6d64d5ded86fa142e145a58722d7259f8063b2e";
const id = `0x${"1".repeat(64)}` as Hex,
  agreement = `0x${"2".repeat(64)}` as Hex;
const zeroMode = toHex(0n, { size: 32 });
const approvalAbi = parseAbi([
  "event Approval(address indexed owner,address indexed spender,uint256 value)",
]);
function envelope(
  to: Address,
  data: Hex,
  options: { owner?: Address; mode?: Hex; value?: bigint; batch?: boolean } = {},
) {
  const context = encodeAbiParameters(delegationParameters, [
    [
      {
        delegate: "0x0000000000000000000000000000000000000a11",
        delegator: options.owner ?? owner,
        authority: `0x${"f".repeat(64)}`,
        caveats: [],
        salt: 0n,
        signature: "0x1234",
      },
    ],
  ]);
  const call = options.batch
    ? encodeAbiParameters(parseAbiParameters("(address target,uint256 value,bytes callData)[]"), [
        [{ target: to, value: options.value ?? 0n, callData: data }],
      ])
    : concatHex([to, toHex(options.value ?? 0n, { size: 32 }), data]);
  return {
    to: delegationManager as Address,
    from: relayer as Address,
    value: 0n,
    input: encodeFunctionData({
      abi: redemptionAbi,
      functionName: "redeemDelegations",
      args: [[context], [options.mode ?? zeroMode], [call]],
    }),
  };
}
function fixture() {
  const tx = {
    to: token,
    data: encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [vault, 1_000_000n] }),
  };
  const log = {
    address: token,
    topics: encodeEventTopics({
      abi: approvalAbi,
      eventName: "Approval",
      args: { owner, spender: vault },
    }),
    data: encodeAbiParameters([{ type: "uint256" }], [1_000_000n]),
  };
  const receipt = { status: "success", logs: [log] } as unknown as TransactionReceipt;
  const observed = envelope(tx.to, tx.data);
  return {
    tx,
    log,
    receipt,
    observed,
    match: () => matchesDelegatedCall(tx, observed, owner, receipt, vault, token),
  };
}
describe("MetaMask delegated collateral transactions", () => {
  it("recognizes the reported settlement through both MetaMask delegation layers", () => {
    const tx = {
      to: settlement.vault as Address,
      data: encodeFunctionData({
        abi: hedgeVaultAbi,
        functionName: "settle",
        args: [settlement.loan_id as Hex],
      }),
    };
    const observed = {
      ...settlement.observed,
      to: settlement.observed.to as Address,
      from: settlement.observed.from as Address,
      input: settlement.observed.input as Hex,
      value: BigInt(settlement.observed.value),
    };
    expect(
      matchesDelegatedCall(
        tx,
        observed,
        settlement.signer,
        settlement.receipt as unknown as TransactionReceipt,
        settlement.vault as Address,
        settlement.collateral_asset as Address,
      ),
    ).toBe(true);
  });
  it("recognizes the confirmed approval's relayer envelope only with the token's exact owner, spender and amount", () => {
    expect(fixture().match()).toBe(true);
  });
  it("supports default batch execution with the same verified effect", () => {
    const f = fixture();
    f.observed.input = envelope(f.tx.to, f.tx.data, {
      batch: true,
      mode: `0x01${"0".repeat(62)}`,
    }).input;
    expect(f.match()).toBe(true);
  });
  it("supports nested manager execution in a batch", () => {
    const f = fixture();
    const inner = envelope(f.tx.to, f.tx.data);
    f.observed.input = envelope(delegationManager, inner.input, {
      batch: true,
      mode: `0x01${"0".repeat(62)}`,
    }).input;
    expect(f.match()).toBe(true);
  });
  it("binds nested self-execution to the verified outer wallet", () => {
    const f = fixture();
    const inner = encodeFunctionData({
      abi: redemptionAbi,
      functionName: "redeemDelegations",
      args: [
        [encodeAbiParameters(delegationParameters, [[]])],
        [zeroMode],
        [concatHex([f.tx.to, toHex(0n, { size: 32 }), f.tx.data])],
      ],
    });
    f.observed.input = envelope(delegationManager, inner).input;
    expect(f.match()).toBe(true);
    f.observed.input = inner;
    expect(f.match()).toBe(false);
  });
  it.each([
    "outer wallet",
    "inner wallet",
    "target",
    "calldata",
    "value",
    "mode",
    "malformed",
    "missing effect",
  ])("rejects nested execution with a different %s", (field) => {
    const f = fixture();
    const inner = envelope(
      field === "target" ? vault : f.tx.to,
      field === "calldata" ? "0x1234" : f.tx.data,
      {
        owner: field === "inner wallet" ? relayer : owner,
        value: field === "value" ? 1n : 0n,
        mode: field === "mode" ? `0x0001${"0".repeat(60)}` : zeroMode,
      },
    );
    f.observed.input = envelope(
      delegationManager,
      field === "malformed" ? "0xcef6d209" : inner.input,
      { owner: field === "outer wallet" ? relayer : owner },
    ).input;
    if (field === "missing effect") f.receipt.logs = [];
    expect(f.match()).toBe(false);
  });
  it("bounds nested manager decoding", () => {
    const f = fixture();
    for (let i = 0; i < 6; i++)
      f.observed.input = envelope(delegationManager, f.observed.input).input;
    expect(f.match()).toBe(false);
  });
  it.each([
    "wallet",
    "target",
    "calldata",
    "value",
    "manager",
    "missing effect",
    "fake token",
    "spender",
    "amount",
    "revert",
    "malformed",
  ])("rejects a mismatched %s even with a successful-looking envelope", (field) => {
    const f = fixture();
    if (field === "wallet")
      f.observed.input = envelope(f.tx.to, f.tx.data, { owner: relayer }).input;
    if (field === "target") f.observed.input = envelope(vault, f.tx.data).input;
    if (field === "calldata") f.observed.input = envelope(f.tx.to, "0x1234").input;
    if (field === "value") f.observed.input = envelope(f.tx.to, f.tx.data, { value: 1n }).input;
    if (field === "manager") f.observed.to = relayer;
    if (field === "missing effect") f.receipt.logs = [];
    if (field === "fake token") f.log.address = relayer;
    if (field === "spender")
      f.log.topics = encodeEventTopics({
        abi: approvalAbi,
        eventName: "Approval",
        args: { owner, spender: relayer },
      });
    if (field === "amount") f.log.data = encodeAbiParameters([{ type: "uint256" }], [2_000_000n]);
    if (field === "revert") f.receipt.status = "reverted";
    if (field === "malformed") f.observed.input = "0xcef6d209";
    expect(f.match()).toBe(false);
  });
  it.each([
    `0x0001${"0".repeat(60)}`,
    `0xff${"0".repeat(62)}`,
    `0x00000000000012345678${"0".repeat(44)}`,
  ] as Hex[])("rejects try/delegatecall/custom mode %s", (mode) => {
    const f = fixture();
    f.observed.input = envelope(f.tx.to, f.tx.data, { mode }).input;
    expect(f.match()).toBe(false);
  });
  it("does not treat unrelated token approval or missing execution contexts as collateral confirmation", () => {
    const f = fixture();
    f.tx.data = encodeFunctionData({
      abi: tokenAbi,
      functionName: "approve",
      args: [relayer, 1_000_000n],
    });
    f.observed.input = envelope(f.tx.to, f.tx.data).input;
    expect(f.match()).toBe(false);
    f.observed.input = encodeFunctionData({
      abi: redemptionAbi,
      functionName: "redeemDelegations",
      args: [[], [zeroMode], []],
    });
    expect(f.match()).toBe(false);
  });
  it("requires the configured vault's lock event bound to both loan and agreement", () => {
    const tx = {
      to: vault,
      data: encodeFunctionData({ abi: hedgeVaultAbi, functionName: "lock", args: [id, agreement] }),
    };
    const lockId = keccak256(
      encodeAbiParameters([{ type: "string" }, { type: "bytes32" }], ["hedge-lock-v2", agreement]),
    );
    const log = {
      address: vault,
      data: encodeAbiParameters([{ type: "uint256" }], [1_000_000n]),
      topics: encodeEventTopics({
        abi: hedgeVaultAbi,
        eventName: "CollateralLocked",
        args: { loanId: id, lockId },
      }),
    };
    const receipt = { status: "success", logs: [log] } as unknown as TransactionReceipt;
    const observed = envelope(tx.to, tx.data);
    expect(matchesDelegatedCall(tx, observed, owner, receipt, vault, token)).toBe(true);
    log.topics = encodeEventTopics({
      abi: hedgeVaultAbi,
      eventName: "CollateralLocked",
      args: { loanId: id, lockId: agreement },
    });
    expect(matchesDelegatedCall(tx, observed, owner, receipt, vault, token)).toBe(false);
    log.topics = encodeEventTopics({
      abi: hedgeVaultAbi,
      eventName: "CollateralLocked",
      args: { loanId: agreement, lockId },
    });
    expect(matchesDelegatedCall(tx, observed, owner, receipt, vault, token)).toBe(false);
  });
  it("requires a collateral claim to the agreed signing recipient", () => {
    const tx = {
      to: vault,
      data: encodeFunctionData({ abi: hedgeVaultAbi, functionName: "claim", args: [id] }),
    };
    const log = {
      address: vault,
      data: encodeAbiParameters([{ type: "uint256" }], [1_000_000n]),
      topics: encodeEventTopics({
        abi: hedgeVaultAbi,
        eventName: "CollateralClaimed",
        args: { loanId: id, recipient: owner },
      }),
    };
    const receipt = { status: "success", logs: [log] } as unknown as TransactionReceipt;
    const observed = envelope(tx.to, tx.data);
    expect(matchesDelegatedCall(tx, observed, owner, receipt, vault, token)).toBe(true);
    log.topics = encodeEventTopics({
      abi: hedgeVaultAbi,
      eventName: "CollateralClaimed",
      args: { loanId: id, recipient: relayer },
    });
    expect(matchesDelegatedCall(tx, observed, owner, receipt, vault, token)).toBe(false);
  });
});
