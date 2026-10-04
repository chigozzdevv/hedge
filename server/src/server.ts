import "dotenv/config";
import { buildHedgeApp } from "./app.js";
import { env, assertServerConfig, localTestOrigins } from "./shared/config/env.js";
import { connectDatabase, closeDatabase } from "./shared/database/database.client.js";
import { closeRedis } from "./shared/queue/queue.client.js";
import { stopWorkers } from "./shared/queue/queue.worker.js";
import { hedgeLogger } from "./shared/logging/hedge-logger.js";
import { appDirectory } from "./shared/config/workspace.js";
import { resolve } from "node:path";
import { createTestnetService } from "./features/operator/testnet-service.js";
import { loadOperatorPolicy } from "./features/operator/quote-policy.js";
import { startCcipWorker } from "./features/credit/ccip-worker.js";
import { loadPublicConfig } from "./shared/config/hedge-config.js";
async function startHedgeServer(): Promise<void> {
  assertServerConfig();
  const localTest = process.env["HEDGE_LOCAL_TESTNET"] === "1";
  if (localTest && env.host !== "127.0.0.1")
    throw new Error("Local test wallet requires loopback binding");
  const root = appDirectory(resolve(process.cwd(), ".."));
  loadPublicConfig(root);
  const policy = await loadOperatorPolicy(root);
  if (env.databaseDriver !== "none") await connectDatabase();
  const testnet = localTest ? await createTestnetService(root, policy) : undefined;
  const app = buildHedgeApp({
    testnet,
    ...(testnet ? { corsOrigins: localTestOrigins() } : {}),
  });
  const stopCcip = testnet ? startCcipWorker(testnet.reader, testnet.relay) : undefined;
  const stopLegacy = testnet?.legacy
    ? startCcipWorker(testnet.legacy.reader, testnet.legacy.relay)
    : undefined;
  app.addHook("onClose", async () => {
    stopCcip?.();
    stopLegacy?.();
    await stopWorkers();
    await closeRedis();
    await closeDatabase();
  });
  try {
    if (env.databaseDriver !== "none") await connectDatabase();
    await app.listen({ port: env.port, host: env.host });
  } catch (error) {
    await app.close();
    throw error;
  }
  hedgeLogger.info("hedge-server-listening", { port: env.port, host: env.host });
  let shutdown: Promise<void> | undefined;
  const stop = (): void => {
    shutdown ??= app.close().catch(() => {
      process.exitCode = 1;
      hedgeLogger.error("hedge-server-close-failed");
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
void startHedgeServer().catch(() => {
  process.exitCode = 1;
  hedgeLogger.error("hedge-server-start-failed");
});
