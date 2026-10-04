import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import mongoose from "mongoose";
import { buildHedgeApp } from "../../src/app.js";
import {
  address,
  makeReader,
  manifest,
  observed,
  credit,
  offer,
  funding,
} from "../chain/hedge-reader.fixture.js";
import { creditRepo } from "../../src/features/credit/credit.repo.js";
import { collateralRepo } from "../../src/features/collateral/collateral.repo.js";
import { queue } from "../../src/shared/queue/queue.client.js";
const apps: FastifyInstance[] = [];
beforeEach(() => {
  vi.spyOn(mongoose.connection, "readyState", "get").mockReturnValue(0);
});
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});
function app(reader = makeReader()) {
  const result = buildHedgeApp({ protocol: { manifest, reader }, readiness: async () => true });
  apps.push(result);
  return result;
}
describe("Hedge feature routes", () => {
  it("routes credit, Base collateral and operator reads through feature services and serializes base units", async () => {
    const reader = makeReader(),
      server = app(reader);
    const loan = await server.inject("/credits/loan-1");
    expect(loan.statusCode).toBe(200);
    expect(loan.json().data.amount_due).toBe("1010000");
    const custody = await server.inject("/credits/loan-1/collateral");
    expect(custody.json().chainId).toBe(84532);
    expect(custody.json().data.lock_id).toBe("lock-1");
    expect((await server.inject(`/operator/${address}`)).json().data.free_capital).toBe("10000000");
    expect(reader.verifyDeployment).toHaveBeenCalledTimes(1);
  });
  it("parses the HTTP intent into the SDK schema without creating or reserving a loan", async () => {
    const reader = makeReader(),
      server = app(reader);
    const response = await server.inject({
      method: "POST",
      url: "/intents/offers",
      payload: {
        funding: { ...funding, amount: "1000000" },
        credit: { duration: 86400 },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()[0].data.id).toBe("offer-1");
    expect(reader.offers).toHaveBeenCalledWith({ funding, credit: { duration: 86400 } });
    const malformed = await server.inject({
      method: "POST",
      url: "/intents/offers",
      payload: { funding: { ...funding, amount: "1.5" } },
    });
    expect(malformed.statusCode).toBe(400);
    expect(reader.offers).toHaveBeenCalledTimes(1);
  });
  it("rejects substituted credit/instance/chain identities before saving a snapshot", async () => {
    const save = vi.spyOn(creditRepo, "save");
    for (const value of [
      observed({ ...credit, credit_id: "loan-2" }),
      observed({ ...credit, instance_id: "other" }),
      observed(credit, "base"),
    ]) {
      const server = app(makeReader({ credit: async () => value }));
      expect((await server.inject("/credits/loan-1")).statusCode).toBe(502);
    }
    expect(save).not.toHaveBeenCalled();
  });
  it("never falls back to stale cache if the configured contract reader reports no loan", async () => {
    const server = app(makeReader({ credit: async () => null }));
    const result = await server.inject("/credits/loan-1");
    expect(result.statusCode).toBe(404);
    expect(result.json()).toEqual({ error: "credit-not-found" });
  });
  it("treats invalid reader output as an upstream failure before persisting it", async () => {
    const save = vi.spyOn(creditRepo, "save");
    for (const value of [
      { ...observed(credit), observedBlock: -1 },
      observed({ ...credit, amount_due: -1n }),
    ]) {
      const result = await app(makeReader({ credit: async () => value })).inject("/credits/loan-1");
      expect(result.statusCode).toBe(502);
      expect(result.json()).toEqual({ error: "hedge-observation-invalid" });
    }
    expect(save).not.toHaveBeenCalled();
  });
  it("does not report tracking success or enqueue work when persistence is lost", async () => {
    vi.spyOn(mongoose.connection, "readyState", "get").mockReturnValue(1);
    vi.spyOn(creditRepo, "save").mockResolvedValue(false);
    vi.spyOn(collateralRepo, "save").mockResolvedValue(false);
    const push = vi.spyOn(queue, "push").mockResolvedValue();
    const server = app();
    for (const url of ["/credits", "/collateral"]) {
      const result = await server.inject({ method: "POST", url, payload: { creditId: "loan-1" } });
      expect(result.statusCode).toBe(503);
      expect(result.json()).toEqual({ error: "tracking-storage-unavailable" });
    }
    expect(push).not.toHaveBeenCalled();
  });
  it("does not return funding for a different request or accept a substituted offer", async () => {
    const server = app(makeReader({ offer: async () => observed({ ...offer, id: "other" }) }));
    expect((await server.inject("/offers/offer-1")).statusCode).toBe(502);
    const results = await server.inject({
      method: "POST",
      url: "/intents/offers",
      payload: { funding: { ...funding, amount: "2000000" } },
    });
    expect(results.json()).toEqual([]);
  });
  it("prevents tracking requests from supplying borrower state or collateral instructions", async () => {
    const reader = makeReader(),
      server = app(reader);
    const result = await server.inject({
      method: "POST",
      url: "/credits",
      payload: { creditId: "loan-1", state: "repaid", borrower: "attacker" },
    });
    expect(result.statusCode).toBe(400);
    expect(reader.credit).not.toHaveBeenCalled();
    expect(
      (await server.inject({ method: "POST", url: "/credits/loan-1/repay", payload: {} }))
        .statusCode,
    ).toBe(404);
  });
});
