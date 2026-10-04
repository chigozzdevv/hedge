import {
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  stringToHex,
  type Hex,
  type TransactionSerializedLegacy,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sameAddress, type Chain, type EvmHedgeReader, type EvmTransaction } from "@hedge/sdk";
import { readWallets } from "../config/wallets.js";
import { readRecord, createRecord, withRecordLease } from "../database/records.js";

type SignedTransaction = {
  chainId: number;
  sender: string;
  to: string;
  data: Hex;
  value: string;
  serialized: Hex;
  hash: Hex;
};

/** Operator relays and optional test-wallet transactions save signed bytes before broadcast. */
export class LocalTestSigner {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly root: string,
    private readonly reader: EvmHedgeReader,
  ) {}
  private scope(chain: Chain, borrower = false) {
    const wallet = readWallets(this.root)[borrower ? "base" : chain];
    return `signer:${this.reader.manifest[chain].chain_id}:${wallet.address.toLowerCase()}`;
  }
  async saved(chain: Chain, key: string): Promise<{ hash: Hex; value: bigint } | undefined> {
    const record = await readRecord<SignedTransaction>(
      this.scope(chain),
      keccak256(stringToHex(key)),
    );
    return record ? { hash: record.hash, value: BigInt(record.value) } : undefined;
  }
  send(tx: EvmTransaction, borrower: boolean): Promise<Hex> {
    const run = this.tail.catch(() => undefined).then(() => this.submit(tx, borrower));
    this.tail = run;
    return run;
  }
  private async submit(tx: EvmTransaction, borrower: boolean): Promise<Hex> {
    const scope = this.scope(tx.chain, borrower);
    return withRecordLease(scope, async (assertOwned) => {
      const key = keccak256(stringToHex(tx.key));
      const wallet = readWallets(this.root)[borrower ? "base" : tx.chain];
      const chainId = this.reader.manifest[tx.chain].chain_id;
      const value = tx.value ?? 0n;
      const client = this.reader.clients[tx.chain];
      const maximumValue = tx.chain === "hedera" ? 12n * 10n ** 18n : 10n ** 15n;
      if (value < 0n || value > maximumValue)
        throw new Error("Transaction value exceeds the signer budget");
      let record = await readRecord<SignedTransaction>(scope, key);
      if (!record) {
        if ((await client.getChainId()) !== chainId)
          throw new Error("Signer RPC is on the wrong chain");
        const account = privateKeyToAccount(wallet.private_key as Hex);
        const [latest, pending, gasPrice, balance, estimated] = await Promise.all([
          client.getTransactionCount({ address: account.address, blockTag: "latest" }),
          client.getTransactionCount({ address: account.address, blockTag: "pending" }),
          client.getGasPrice(),
          client.getBalance({ address: account.address }),
          client.estimateGas({ account: account.address, to: tx.to, data: tx.data, value }),
        ]);
        if (latest !== pending)
          throw new Error("Wallet has a pending transaction; confirm it first");
        const gas = (estimated * 125n + 99n) / 100n;
        const budget = tx.chain === "hedera" ? 13n * 10n ** 18n : 3n * 10n ** 15n;
        const reserve =
          tx.chain === "hedera" ? (borrower ? 25n * 10n ** 16n : 5n * 10n ** 18n) : 5n * 10n ** 15n;
        if (gas * gasPrice + value > budget)
          throw new Error("Gas and value exceed the signer budget");
        if (balance < gas * gasPrice + value + reserve)
          throw new Error("Top up wallet gas; the transaction would exhaust its retained reserve");
        await assertOwned();
        const serialized = await account.signTransaction({
          chainId,
          to: tx.to,
          data: tx.data,
          value,
          nonce: pending,
          gas,
          gasPrice,
          type: "legacy",
        });
        record = {
          chainId,
          sender: account.address,
          to: tx.to,
          data: tx.data,
          value: String(value),
          serialized,
          hash: keccak256(serialized),
        };
        await assertOwned();
        record = await createRecord(scope, key, record);
      }
      const signed = parseTransaction(record.serialized);
      if (
        record.chainId !== chainId ||
        !sameAddress(record.sender, wallet.address) ||
        !sameAddress(record.to, tx.to) ||
        record.data !== tx.data ||
        BigInt(record.value) !== value ||
        signed.type !== "legacy" ||
        signed.chainId !== chainId ||
        !sameAddress(signed.to ?? "", tx.to) ||
        (signed.data ?? "0x") !== tx.data ||
        (signed.value ?? 0n) !== value ||
        keccak256(record.serialized) !== record.hash ||
        !sameAddress(
          await recoverTransactionAddress({
            serializedTransaction: record.serialized as TransactionSerializedLegacy,
          }),
          wallet.address,
        )
      )
        throw new Error("The saved transaction does not match this operation or wallet");
      await assertOwned();
      let sent: Hex | undefined;
      try {
        sent = await client.sendRawTransaction({ serializedTransaction: record.serialized });
      } catch {
        /* RPC ambiguity resumes the exact persisted hash; no new nonce is created. */
      }
      if (sent && sent !== record.hash)
        throw new Error("RPC returned a different transaction hash");
      await client.waitForTransactionReceipt({ hash: record.hash, timeout: 90_000 });
      return record.hash;
    });
  }
}
