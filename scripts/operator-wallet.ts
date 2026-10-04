import {
  formatEther,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type Address,
  type Hex,
  type TransactionSerializedLegacy,
} from "viem";
import { sameAddress, type EvmHedgeReader, type EvmTransaction, type EvmWallet } from "@hedge/sdk";
import { privateKeyToAccount } from "viem/accounts";
import { readWallets } from "../server/src/shared/config/wallets.js";

export type SignedCall = { to: Address; data: Hex; serialized: Hex; hash: Hex };

export async function validateSignedCall(
  call: SignedCall,
  reader: EvmHedgeReader,
  operator: string,
): Promise<void> {
  const transaction = parseTransaction(call.serialized);
  if (
    keccak256(call.serialized) !== call.hash ||
    transaction.type !== "legacy" ||
    transaction.chainId !== reader.manifest.hedera.chain_id ||
    !sameAddress(transaction.to ?? "", call.to) ||
    (transaction.data ?? "0x") !== call.data ||
    (transaction.value ?? 0n) !== 0n ||
    !sameAddress(
      await recoverTransactionAddress({
        serializedTransaction: call.serialized as TransactionSerializedLegacy,
      }),
      operator,
    )
  )
    throw new Error("Saved liquidity transaction differs from this operator or deployment");
}

export class OperatorWallet implements EvmWallet {
  constructor(
    private readonly root: string,
    private readonly reader: EvmHedgeReader,
    private readonly operator: string,
    private readonly calls: SignedCall[],
    private readonly save: () => Promise<void>,
    private readonly validate: (tx: EvmTransaction) => void,
    private readonly maxFee: bigint,
    private readonly reserve: bigint,
    private readonly checkInterrupted: () => void = () => undefined,
    private readonly assertOwned: () => Promise<void> = async () => undefined,
  ) {}

  private signer() {
    const wallet = readWallets(this.root).hedera;
    if (!sameAddress(wallet.address, this.operator))
      throw new Error("Hedera wallet does not match operator in hedge.config.json");
    return privateKeyToAccount(wallet.private_key as Hex);
  }

  async wallet(chain: "hedera" | "base") {
    if (chain !== "hedera") throw new Error("Liquidity uses the Hedera operator wallet");
    return {
      chain_id: this.reader.manifest.hedera.chain_id,
      address: this.operator,
      account_id: await this.reader.config.resolveAccount(this.operator),
    };
  }
  connect = this.wallet.bind(this);

  async verifySigner(): Promise<void> {
    this.signer();
  }

  async broadcast(call: SignedCall): Promise<Hex> {
    await validateSignedCall(call, this.reader, this.operator);
    await this.assertOwned();
    this.checkInterrupted();
    let submitted: Hex | undefined;
    try {
      submitted = await this.reader.clients.hedera.sendRawTransaction({
        serializedTransaction: call.serialized,
      });
    } catch {
      console.log(`Checking saved transaction ${call.hash}; no replacement will be created.`);
    }
    if (submitted && submitted !== call.hash)
      throw new Error("RPC returned a different transaction hash; inspect the saved operation");
    return call.hash;
  }

  async send(tx: EvmTransaction): Promise<Hex> {
    this.checkInterrupted();
    this.validate(tx);
    const saved = this.calls.find((call) => sameAddress(call.to, tx.to) && call.data === tx.data);
    if (saved) return this.broadcast(saved);
    await this.verifySigner();
    const client = this.reader.clients.hedera;
    const account = this.operator as Address;
    const [nonce, pending, gasPrice, balance, estimate] = await Promise.all([
      client.getTransactionCount({ address: account, blockTag: "latest" }),
      client.getTransactionCount({ address: account, blockTag: "pending" }),
      client.getGasPrice(),
      client.getBalance({ address: account }),
      client.estimateGas({ account, to: tx.to, data: tx.data, value: 0n }),
    ]);
    if (nonce !== pending) throw new Error("Operator has a pending transaction; confirm it first");
    const gas = (estimate * 125n + 99n) / 100n;
    const fee = gas * gasPrice;
    if (fee > this.maxFee) throw new Error("Gas exceeds HEDGE_OPERATOR_MAX_FEE_HBAR");
    if (balance < fee + this.reserve)
      throw new Error(
        "Top up operator HBAR; this transaction would exhaust HEDGE_OPERATOR_MIN_HBAR",
      );
    console.log(`${tx.label}: maximum gas ${formatEther(fee)} HBAR`);
    this.checkInterrupted();
    const serialized = await this.signer().signTransaction({
      chainId: this.reader.manifest.hedera.chain_id,
      to: tx.to,
      data: tx.data,
      nonce,
      gas,
      gasPrice,
      value: 0n,
      type: "legacy",
    });
    const parsed = parseTransaction(serialized);
    if (parsed.nonce !== nonce || parsed.gas !== gas || parsed.gasPrice !== gasPrice)
      throw new Error("Signed transaction exceeds the prepared nonce or gas budget");
    const call = { to: tx.to, data: tx.data, serialized, hash: keccak256(serialized) };
    await validateSignedCall(call, this.reader, this.operator);
    this.calls.push(call);
    await this.save();
    console.log(`Saved transaction: ${call.hash}`);
    return this.broadcast(call);
  }
}
