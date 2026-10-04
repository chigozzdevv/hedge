import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { addressSchema, chainSchema } from "@hedge/schema";
import type { Address, Hex } from "viem";
import type { OperatorRuntime } from "./operator-runtime.js";
import { env, localTestOrigins } from "../../shared/config/env.js";
import { HedgeHttpError } from "../../shared/http/http.errors.js";
import { offerRequest } from "./offer-request.js";
import { hedgeLogger } from "../../shared/logging/hedge-logger.js";

const transaction = z.strictObject({
  chain: chainSchema,
  to: addressSchema,
  data: z.string().regex(/^0x(?:[\da-fA-F]{2}){4,4096}$/),
  value: z
    .string()
    .regex(/^\d{1,40}$/)
    .optional(),
  key: z.string().min(1).max(256),
  label: z.string().min(1).max(100),
});
export function testnetRoute(app: FastifyInstance, service: OperatorRuntime) {
  const allowedOrigins = localTestOrigins();
  const attempt = async <T>(
    operation: string,
    action: () => Promise<T>,
    message: string,
  ): Promise<T> => {
    try {
      return await action();
    } catch (error) {
      hedgeLogger.warn("testnet-operation-pending", {
        operation,
        reason: error instanceof Error ? error.message.slice(-1800) : "operation failed",
      });
      throw new HedgeHttpError(503, message);
    }
  };
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/testnet/")) return;
    if (
      ![`127.0.0.1:${env.port}`].includes(request.headers.host ?? "") ||
      !allowedOrigins.includes(request.headers.origin ?? "")
    )
      return reply.status(403).send({ error: "loopback-origin-required" });
    if (request.method === "OPTIONS" || request.url.split("?")[0] === "/testnet/config") return;
    if (request.headers["x-hedge-session"] !== service.session)
      return reply.status(403).send({ error: "session-required" });
  });
  app.get("/testnet/config", async (request) => {
    const { deployment } = z
      .object({ deployment: z.enum(["v2", "v3"]).optional() })
      .parse(request.query);
    if (deployment === "v2") {
      if (!service.legacy) throw new HedgeHttpError(404, "Legacy deployment is unavailable");
      return { ...service.profile, config: service.legacy.config };
    }
    return service.profile;
  });
  app.get("/testnet/loans", async () => ({ ids: await service.loans() }));
  app.post("/testnet/offers", async (request) => {
    const body = offerRequest.parse(request.body);
    return { ids: await service.discover(body.request, body.base_owner) };
  });
  app.post("/testnet/relay", async (request) => {
    const { credit_id } = z
      .strictObject({ credit_id: z.string().regex(/^0x[\da-fA-F]{64}$/) })
      .parse(request.body);
    await attempt(
      "relay",
      () => service.relay(credit_id),
      "CCIP submission needs attention. Your loan is saved; refresh its status.",
    );
    return { submitted: true };
  });
  app.post("/testnet/wallet", async (request) => {
    const tx = transaction.parse(request.body);
    return {
      hash: await attempt(
        "wallet",
        () =>
          service.send({
            ...tx,
            to: tx.to as Address,
            data: tx.data as Hex,
            value: BigInt(tx.value ?? "0"),
          }),
        "Wallet request could not be sent. Refresh the quote or loan and check the test wallet's gas balance.",
      ),
    };
  });
}
