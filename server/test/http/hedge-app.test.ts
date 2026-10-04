import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildHedgeApp } from "../../src/app.js";
import { HedgeHttpError } from "../../src/shared/http/http.errors.js";
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
function app(readiness = async () => true) {
  const value = buildHedgeApp({ readiness, corsOrigins: ["https://hedge.example"] });
  apps.push(value);
  return value;
}
describe("Hedge HTTP foundation", () => {
  it("serves liveness and infrastructure readiness without pretending a loan is ready", async () => {
    const server = app();
    expect((await server.inject("/health")).json()).toEqual({ ok: true, service: "hedge-server" });
    const ready = await server.inject("/ready");
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ ok: true, service: "hedge-server", scope: "infrastructure" });
    const credit = await server.inject("/credits/loan-1");
    expect(credit.statusCode).toBe(503);
    expect(credit.json()).toEqual({ error: "hedge-reader-unconfigured" });
  });
  it.each([
    async () => false,
    async () => {
      throw new Error("dependency unavailable");
    },
  ])("fails readiness when a dependency fails", async (readiness) => {
    const server = app(readiness);
    expect((await server.inject("/ready")).statusCode).toBe(503);
    expect((await server.inject("/health")).statusCode).toBe(200);
  });
  it("permits only configured browser origins and handles preflight", async () => {
    const server = app();
    const approved = await server.inject({
      url: "/health",
      headers: { origin: "https://hedge.example" },
    });
    expect(approved.headers["access-control-allow-origin"]).toBe("https://hedge.example");
    const denied = await server.inject({
      url: "/health",
      headers: { origin: "https://other.example" },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
    expect(
      (
        await server.inject({
          method: "OPTIONS",
          url: "/health",
          headers: { origin: "https://hedge.example" },
        })
      ).statusCode,
    ).toBe(204);
  });
  it("keeps framework client errors and hides unexpected internal errors", async () => {
    const server = app();
    server.get("/controlled", () => {
      throw new HedgeHttpError(409, "operation-conflict");
    });
    server.get("/unexpected", () => {
      throw new Error("private connection details");
    });
    server.post("/input", async (request) => request.body);
    expect((await server.inject("/controlled")).statusCode).toBe(409);
    expect((await server.inject("/unexpected")).json()).toEqual({ error: "internal" });
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/input",
          headers: { "content-type": "application/json" },
          payload: "{",
        })
      ).statusCode,
    ).toBe(400);
  });
});
