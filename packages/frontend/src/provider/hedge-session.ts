import {
  create_hedge,
  createAccountResolver,
  EvmHedgeAdapter,
  EvmHedgeReader,
  HedgeError,
  loadHedgeConfig,
  type ClientConfig,
  type EvmWallet,
} from "@hedge/sdk";
import { hashSchema, offerAuthorizationMessage, type LoanRequest } from "@hedge/schema";
import { createHedgeModal } from "../modal/modal-controller";
import { browserJournal } from "./browser-journal";

export interface HedgeSetup {
  wallet: EvmWallet | ((reader: EvmHedgeReader) => EvmWallet);
  config?: string | ClientConfig;
  request?: typeof fetch;
}

/** Shared setup for the provider. No wallet prompts, transactions or offer creation at startup. */
export async function setupHedge(options: HedgeSetup, signal?: AbortSignal) {
  const request = options.request ?? globalThis.fetch;
  const config = await loadHedgeConfig(options.config, request, signal);
  const reader = new EvmHedgeReader({
    manifest: config.deployment,
    rpc: config.rpc,
    startBlock: {
      hedera: BigInt(config.start_block.hedera),
      base: BigInt(config.start_block.base),
    },
    resolveAccount: createAccountResolver(config.mirror_url),
  });
  const wallet = typeof options.wallet === "function" ? options.wallet(reader) : options.wallet;
  const { journal, restore, forget } = browserJournal(
    config.deployment.instance_id,
    config.operator,
  );
  const post = async (path: string, body: unknown): Promise<unknown> => {
    const send = (value: unknown) =>
      request(`${config.operator_url.replace(/\/$/, "")}/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(value, (_key, value) =>
          typeof value === "bigint" ? String(value) : value,
        ),
        signal: AbortSignal.timeout(60_000),
      });
    let response = await send(body);
    if (path === "offers" && response.status === 401) {
      const challenge = (await response.json()) as { error?: string; expires_at?: number };
      const now = Math.floor(Date.now() / 1000);
      if (
        challenge.error !== "wallet-authorization-required" ||
        !Number.isInteger(challenge.expires_at) ||
        challenge.expires_at! <= now ||
        challenge.expires_at! > now + 300
      )
        throw new HedgeError("OPERATOR_UNAVAILABLE", "Invalid operator authorization challenge");
      if (!wallet.signMessage)
        throw new HedgeError(
          "WALLET_UNAVAILABLE",
          "Your wallet must support message signing to request a loan offer",
        );
      const input = body as { request: LoanRequest; base_owner: string };
      const [borrower, owner] = await Promise.all([wallet.wallet("hedera"), wallet.wallet("base")]);
      if (
        !borrower ||
        !owner ||
        borrower.address.toLowerCase() !== input.request.funding.recipient.address.toLowerCase() ||
        owner.address.toLowerCase() !== input.base_owner.toLowerCase()
      )
        throw new HedgeError("WALLET_UNAVAILABLE", "Reconnect the wallets for this loan request");
      const message = offerAuthorizationMessage({
        ...input,
        operator_url: config.operator_url,
        instance_id: config.deployment.instance_id,
        expires_at: challenge.expires_at!,
      });
      const borrower_signature = await wallet.signMessage("hedera", message);
      const owner_signature =
        owner.address.toLowerCase() === borrower.address.toLowerCase()
          ? borrower_signature
          : await wallet.signMessage("base", message);
      response = await send({
        ...input,
        authorization: {
          expires_at: challenge.expires_at,
          borrower_signature,
          owner_signature,
        },
      });
    }
    if (!response.ok)
      throw new HedgeError(
        "OPERATOR_UNAVAILABLE",
        `Hedge ${path} service failed (HTTP ${response.status})`,
      );
    return response.json();
  };
  const adapter = new EvmHedgeAdapter({
    reader,
    operator: config.operator,
    wallet,
    journal,
    discover: async (request, base_owner) => {
      const result = await post("offers", { request, base_owner });
      if (!result || typeof result !== "object" || !("ids" in result) || !Array.isArray(result.ids))
        throw new HedgeError("OFFER_INVALID", "Hedge offer discovery returned an invalid response");
      return result.ids.map((id: unknown) => hashSchema.parse(id));
    },
    relay: async (credit_id) => {
      await post("relay", { credit_id });
    },
  });
  const modal = createHedgeModal(adapter, forget);
  const client = create_hedge({ manifest: config.deployment, adapter, modal: modal.renderer });
  await client.ready();
  signal?.throwIfAborted();
  const checkpoint = restore();
  if (checkpoint) modal.remember(checkpoint);
  return { client, modal, adapter };
}
export type HedgeSession = Awaited<ReturnType<typeof setupHedge>>;
