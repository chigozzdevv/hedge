import { decodeEventLog, type Hex } from "viem";
import { hedgeLendingAbi } from "@hedge/bindings";
import type { EvmHedgeReader } from "@hedge/sdk";
import { hedgeLogger } from "../../shared/logging/hedge-logger.js";

/** Explicitly registered discovery worker. It sponsors existing obligations, never authorizes outcomes. */
export function startCcipWorker(reader: EvmHedgeReader, relay: (id: string) => Promise<void>) {
  let running = false,
    stopped = false,
    cursor = reader.config.startBlock.hedera;
  const ids = new Set<Hex>();
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const end = await reader.clients.hedera.getBlockNumber();
      for (const log of await reader.logs("hedera", cursor)) {
        try {
          const event = decodeEventLog({
            abi: hedgeLendingAbi,
            data: log.data,
            topics: log.topics,
          });
          if (event.eventName === "LoanAccepted") ids.add(event.args.loanId);
        } catch {
          /* Unrelated event. */
        }
      }
      cursor = end > 2n ? end - 2n : end;
      for (const id of ids) {
        try {
          await relay(id);
          const summary = await reader.summary(id);
          if (
            ["returned", "recovered"].includes(summary.collateral_state) ||
            (summary.state === "repaid" && summary.collateral_state === "settled") ||
            (summary.state === "cancelled" &&
              summary.collateral_state === "unlocked" &&
              (await reader.outbox(id, 2)).delivered)
          )
            ids.delete(id);
        } catch (error) {
          hedgeLogger.warn("ccip-loan-pending", {
            loanId: id,
            reason: error instanceof Error ? error.message : "chain read failed",
          });
        }
      }
    } catch (error) {
      hedgeLogger.warn("ccip-worker-pending", {
        reason: error instanceof Error ? error.message : "chain read failed",
      });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), 3000);
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
