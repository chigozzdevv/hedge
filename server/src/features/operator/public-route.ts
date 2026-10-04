import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { verifyMessage, type Hex } from "viem";
import { offerAuthorizationMessage } from "@hedge/schema";
import { HedgeHttpError } from "../../shared/http/http.errors.js";
import { requestLimiter } from "../../shared/http/http-limit.js";
import { hedgeLogger } from "../../shared/logging/hedge-logger.js";
import { offerRequest } from "./offer-request.js";
import type { OperatorRuntime } from "./operator-runtime.js";

const signature = z.string().regex(/^0x[\da-fA-F]{130}$/);
const authorizedOffer = offerRequest.extend({
  authorization: z
    .strictObject({
      expires_at: z.number().int().positive(),
      borrower_signature: signature,
      owner_signature: signature,
    })
    .optional(),
});

export function publicOperatorRoute(app: FastifyInstance, service: OperatorRuntime): void {
  const quotes = requestLimiter(12, 60_000);
  app.get("/operator/config", async () => service.publicProfile);
  app.post("/operator/offers", async (request, reply) => {
    const body = authorizedOffer.parse(request.body);
    const now = Math.floor(Date.now() / 1000);
    if (!body.authorization)
      return reply.status(401).send({
        error: "wallet-authorization-required",
        expires_at: now + 300,
      });
    if (body.authorization.expires_at <= now || body.authorization.expires_at > now + 300)
      throw new HedgeHttpError(401, "wallet-authorization-expired");
    const message = offerAuthorizationMessage({
      ...body,
      operator_url: service.publicProfile.config.operator_url,
      instance_id: service.publicProfile.config.deployment.instance_id,
      expires_at: body.authorization.expires_at,
    });
    const verified = await Promise.all([
      verifyMessage({
        address: body.request.funding.recipient.address as Hex,
        message,
        signature: body.authorization.borrower_signature as Hex,
      }),
      verifyMessage({
        address: body.base_owner as Hex,
        message,
        signature: body.authorization.owner_signature as Hex,
      }),
    ]).catch(() => [false, false]);
    if (verified.some((value) => !value))
      throw new HedgeHttpError(401, "wallet-authorization-invalid");
    if (!quotes(body.request.funding.recipient.address.toLowerCase()))
      throw new HedgeHttpError(429, "quote-rate-limited");
    try {
      return { ids: await service.discover(body.request, body.base_owner) };
    } catch (error) {
      hedgeLogger.warn("operator-quote-unavailable", {
        reason: error instanceof Error ? error.message.slice(-1800) : "quote failed",
      });
      throw new HedgeHttpError(
        503,
        "Loan offer is unavailable. Check the amount, collateral and operator liquidity.",
      );
    }
  });
  app.post("/operator/relay", async (request) => {
    const { credit_id } = z
      .strictObject({
        credit_id: z.string().regex(/^0x[\da-fA-F]{64}$/),
      })
      .parse(request.body);
    try {
      await service.relay(credit_id);
      return { submitted: true };
    } catch (error) {
      hedgeLogger.warn("operator-relay-pending", {
        reason: error instanceof Error ? error.message.slice(-1800) : "relay failed",
      });
      throw new HedgeHttpError(503, "CCIP submission is pending. Your loan remains saved.");
    }
  });
}
