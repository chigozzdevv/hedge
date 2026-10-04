import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { HedgeHttpError } from "./http.errors.js";
export function registerHttpErrors(app: FastifyInstance): void {
  app.setErrorHandler((error, _request, reply) => {
    if (
      error instanceof HedgeHttpError &&
      Number.isInteger(error.status) &&
      error.status >= 400 &&
      error.status <= 599
    )
      return reply.status(error.status).send({ error: error.message });
    if (error instanceof ZodError)
      return reply.status(400).send({ error: "validation-failed", issues: error.issues });
    if (
      error &&
      typeof error === "object" &&
      "statusCode" in error &&
      typeof error.statusCode === "number" &&
      error.statusCode >= 400 &&
      error.statusCode < 500
    )
      return reply.status(error.statusCode).send({ error: "request-invalid" });
    return reply.status(500).send({ error: "internal" });
  });
}
