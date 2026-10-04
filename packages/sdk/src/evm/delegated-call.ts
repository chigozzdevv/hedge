import {
  decodeAbiParameters,
  decodeEventLog,
  decodeFunctionData,
  encodeAbiParameters,
  keccak256,
  parseAbi,
  parseAbiParameters,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { hedgeVaultAbi } from "@hedge/bindings";
import { tokenAbi } from "./chain-reader";
import { sameAddress } from "./address";

// MetaMask v1.3.0: https://github.com/MetaMask/delegation-framework/tree/v1.3.0/src
export const delegationManager = "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3";
export const redemptionAbi = parseAbi([
  "function redeemDelegations(bytes[] permissionContexts,bytes32[] modes,bytes[] executionCallDatas)",
]);
export const delegationParameters = [
  {
    type: "tuple[]",
    name: "delegations",
    components: [
      { type: "address", name: "delegate" },
      { type: "address", name: "delegator" },
      { type: "bytes32", name: "authority" },
      {
        type: "tuple[]",
        name: "caveats",
        components: [
          { type: "address", name: "enforcer" },
          { type: "bytes", name: "terms" },
          { type: "bytes", name: "args" },
        ],
      },
      { type: "uint256", name: "salt" },
      { type: "bytes", name: "signature" },
    ],
  },
] as const;
const executions = parseAbiParameters("(address target,uint256 value,bytes callData)[]");
const approvalAbi = parseAbi([
  "event Approval(address indexed owner,address indexed spender,uint256 value)",
]);
interface Call {
  to: Address;
  data: Hex;
  value?: bigint;
}
interface Observed {
  to: Address | null;
  from: Address;
  input: Hex;
  value: bigint;
}

function matchesExecution(
  expected: Call,
  input: Hex,
  caller: string,
  signer: string,
  depth = 0,
): boolean {
  if (depth > 4) return false;
  const { args } = decodeFunctionData({ abi: redemptionAbi, data: input });
  const [contexts, modes, calls] = args;
  if (!contexts.length || contexts.length !== modes.length || contexts.length !== calls.length)
    return false;
  let matching = false;
  for (let i = 0; i < contexts.length; i++) {
    const context = contexts[i]!,
      mode = modes[i]!,
      data = calls[i]!;
    // ERC-7579 default/revert execution only; custom modes and try/delegatecall are excluded.
    if (!/^0x(00|01)0{62}$/i.test(mode)) return false;
    const delegates = decodeAbiParameters(delegationParameters, context)[0];
    const root = delegates.at(-1)?.delegator ?? caller;
    if (!sameAddress(root, signer)) return false;
    const inner =
      mode.slice(2, 4) === "01"
        ? decodeAbiParameters(executions, data)[0]
        : data.length >= 106
          ? [
              {
                target: `0x${data.slice(2, 42)}` as Address,
                value: BigInt(`0x${data.slice(42, 106)}`),
                callData: `0x${data.slice(106)}` as Hex,
              },
            ]
          : [];
    matching ||= inner.some(
      (call) =>
        (sameAddress(call.target, expected.to) &&
          call.callData.toLowerCase() === expected.data.toLowerCase() &&
          call.value === (expected.value ?? 0n)) ||
        (sameAddress(call.target, delegationManager) &&
          call.value === 0n &&
          matchesExecution(expected, call.callData, root, signer, depth + 1)),
    );
  }
  return matching;
}

/** Verify the inner intent AND its effect emitted by the configured token/vault. */
export function matchesDelegatedCall(
  expected: Call,
  observed: Observed,
  signer: string,
  receipt: TransactionReceipt,
  vault: Address,
  collateralAsset: Address,
): boolean {
  if (!observed.to || !sameAddress(observed.to, delegationManager) || receipt.status !== "success")
    return false;
  try {
    if (!matchesExecution(expected, observed.input, observed.from, signer)) return false;
    // The envelope alone is not evidence that a token or collateral operation succeeded.
    if (sameAddress(expected.to, collateralAsset)) {
      const call = decodeFunctionData({ abi: tokenAbi, data: expected.data });
      if (call.functionName !== "approve" || !sameAddress(call.args[0], vault)) return false;
      return receipt.logs.some((log) => {
        if (!sameAddress(log.address, collateralAsset)) return false;
        try {
          const { args: event } = decodeEventLog({ abi: approvalAbi, ...log });
          return (
            sameAddress(event.owner, signer) &&
            sameAddress(event.spender, vault) &&
            event.value === call.args[1]
          );
        } catch {
          return false;
        }
      });
    }
    if (!sameAddress(expected.to, vault)) return false;
    const call = decodeFunctionData({ abi: hedgeVaultAbi, data: expected.data });
    if (
      call.functionName !== "lock" &&
      call.functionName !== "claim" &&
      call.functionName !== "settle"
    )
      return false;
    return receipt.logs.some((log) => {
      if (!sameAddress(log.address, vault)) return false;
      try {
        const event = decodeEventLog({ abi: hedgeVaultAbi, ...log });
        if (call.functionName === "lock" && event.eventName === "CollateralLocked") {
          const lockId = keccak256(
            encodeAbiParameters(
              [{ type: "string" }, { type: "bytes32" }],
              ["hedge-lock-v2", call.args[1]],
            ),
          );
          return (
            event.args.loanId === call.args[0] &&
            (event.args.lockId === lockId ||
              event.args.lockId ===
                keccak256(
                  encodeAbiParameters(
                    [{ type: "string" }, { type: "bytes32" }],
                    ["hedge-lock-v3", call.args[1]],
                  ),
                )) &&
            event.args.amount > 0n
          );
        }
        if (call.functionName === "settle" && event.eventName === "CollateralSettled")
          return event.args.loanId === call.args[0] && event.args.repayment > 0n;
        return (
          call.functionName === "claim" &&
          event.eventName === "CollateralClaimed" &&
          event.args.loanId === call.args[0] &&
          sameAddress(event.args.recipient, signer) &&
          event.args.amount > 0n
        );
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}
