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
import { hashSchema } from "@hedge/schema";
import { createHedgeModal } from "../modal/modal-controller";
import { browserJournal } from "./browser-journal";

export interface HedgeSetup {
  wallet: EvmWallet | ((reader: EvmHedgeReader) => EvmWallet);
  config?: string | ClientConfig;
  /** Optional authenticated HTTP transport. Credentials never belong in public config. */
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
  const { journal, restore } = browserJournal(config.deployment.instance_id, config.operator);
  const post = async (path: string, body: unknown): Promise<unknown> => {
    const response = await request(`${config.operator_url.replace(/\/$/, "")}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body, (_key, value) =>
        typeof value === "bigint" ? String(value) : value,
      ),
      signal: AbortSignal.timeout(60_000),
    });
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
  const modal = createHedgeModal(adapter);
  const client = create_hedge({ manifest: config.deployment, adapter, modal: modal.renderer });
  await client.ready();
  signal?.throwIfAborted();
  const checkpoint = restore();
  if (checkpoint) modal.remember(checkpoint);
  return { client, modal, adapter };
}
export type HedgeSession = Awaited<ReturnType<typeof setupHedge>>;
