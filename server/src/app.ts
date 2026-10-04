import Fastify from "fastify";
import { env } from "./shared/config/env.js";
import { registerHttpErrors } from "./shared/http/http.middleware.js";
import { serverReadiness } from "./shared/http/readiness.js";
import { requestLimiter } from "./shared/http/http-limit.js";
import { httpJson } from "./shared/http/http.serialization.js";
import { HedgeChainClient, type HedgeChainConfig } from "./shared/chain/hedge.client.js";
import { createOfferService, offerRoute } from "./features/offer/offer.index.js";
import { createIntentService, intentRoute } from "./features/intent/intent.index.js";
import { createCreditService, creditRoute } from "./features/credit/credit.index.js";
import {
  createCollateralService,
  collateralRoute,
} from "./features/collateral/collateral.index.js";
import { createOperatorService, operatorRoute } from "./features/operator/operator.index.js";
import { testnetRoute } from "./features/operator/testnet-route.js";
import type { TestnetService } from "./features/operator/testnet-service.js";
export interface HedgeAppOptions {
  readiness?: () => Promise<boolean>;
  corsOrigins?: readonly string[];
  protocol?: HedgeChainConfig;
  testnet?: TestnetService;
}
export function buildHedgeApp(options: HedgeAppOptions = {}) {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  registerHttpErrors(app);
  app.addHook("preSerialization", async (_request, _reply, payload) => httpJson(payload));
  const chain = new HedgeChainClient(options.protocol);
  const offers = createOfferService(chain);
  offerRoute(app, offers);
  intentRoute(app, createIntentService(chain, offers));
  creditRoute(app, createCreditService(chain));
  collateralRoute(app, createCollateralService(chain));
  operatorRoute(app, createOperatorService(chain));
  if (options.testnet) testnetRoute(app, options.testnet);
  const origins = new Set(options.corsOrigins ?? env.corsOrigins);
  const allowed = requestLimiter(120, 60_000);
  app.addHook("onRequest", async (request, reply) => {
    if (!allowed(request.ip))
      return reply.status(429).header("retry-after", "60").send({ error: "rate-limited" });
    const origin = request.headers.origin;
    if (!origin) return;
    reply.header("vary", "Origin");
    if (!origins.has(origin)) return reply.status(403).send({ error: "origin-denied" });
    reply.header("access-control-allow-origin", origin);
    reply.header("access-control-allow-methods", "GET, HEAD, POST, OPTIONS");
    reply.header("access-control-allow-headers", "content-type, x-hedge-session");
    if (request.method === "OPTIONS") return reply.status(204).send();
  });
  app.get("/health", async () => ({ ok: true, service: "hedge-server" }));
  app.get("/ready", async (_request, reply) => {
    const ok = await (options.readiness ?? serverReadiness)().catch(() => false);
    return reply
      .status(ok ? 200 : 503)
      .send({ ok, service: "hedge-server", scope: "infrastructure" });
  });
  return app;
}
