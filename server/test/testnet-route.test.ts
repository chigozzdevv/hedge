import { describe, it, expect, vi } from "vitest";
import { buildHedgeApp } from "../src/app.js";
import { env } from "../src/shared/config/env.js";
import type { TestnetService } from "../src/features/operator/testnet-service.js";
const headers = {
  host: `127.0.0.1:${env.port}`,
  origin: "http://127.0.0.1:3002",
  "x-hedge-session": "fixture-session",
};
function fixture() {
  const service = {
    profile: { mode: "local-test-wallet" },
    session: "fixture-session",
    send: vi.fn(async () => `0x${"a".repeat(64)}`),
    relay: vi.fn(async () => undefined),
    discover: vi.fn(async () => [`0x${"c".repeat(64)}`]),
    loans: async () => [],
  } as unknown as TestnetService;
  return { app: buildHedgeApp({ testnet: service, corsOrigins: [headers.origin] }), service };
}
describe("explicit local test wallet boundary", () => {
  const loanRequest = {
    funding: {
      token: `0x${"1".repeat(40)}`,
      amount: "100000",
      recipient: { account_id: "0.0.123", address: `0x${"2".repeat(40)}` },
    },
  };
  it.each([
    null,
    [],
    {},
    ...[
      "1.2",
      "1e6",
      "-1",
      "0",
      "01",
      "0x123",
      (1n << 256n).toString(),
      "9".repeat(79),
      100000,
    ].map((amount) => ({
      ...loanRequest,
      funding: { ...loanRequest.funding, amount },
    })),
  ])("rejects malformed offer requests before operator discovery", async (request) => {
    const { app, service } = fixture();
    const result = await app.inject({
      method: "POST",
      url: "/testnet/offers",
      headers,
      payload: { request, base_owner: loanRequest.funding.recipient.address },
    });
    expect(result.statusCode).toBe(400);
    expect(service.discover).not.toHaveBeenCalled();
    await app.close();
  });
  it("decodes valid loan and collateral base-unit amounts before discovery", async () => {
    const { app, service } = fixture();
    const collateral = { chain_id: 84532, asset: `0x${"3".repeat(40)}`, amount: "200000" };
    const result = await app.inject({
      method: "POST",
      url: "/testnet/offers",
      headers,
      payload: {
        request: { ...loanRequest, collateral },
        base_owner: loanRequest.funding.recipient.address,
      },
    });
    expect(result.statusCode).toBe(200);
    expect(service.discover).toHaveBeenCalledWith(
      {
        ...loanRequest,
        funding: { ...loanRequest.funding, amount: 100000n },
        collateral: { ...collateral, amount: 200000n },
      },
      loanRequest.funding.recipient.address,
    );
    await app.close();
  });
  it("does not enable test wallet routes in a normal server", async () => {
    const app = buildHedgeApp();
    expect((await app.inject({ url: "/testnet/config" })).statusCode).toBe(404);
    await app.close();
  });
  it.each([
    { ...headers, origin: "https://hostile.invalid" },
    { ...headers, host: "hostile.invalid:3001" },
    { host: headers.host, "x-hedge-session": headers["x-hedge-session"] },
    { ...headers, "x-hedge-session": "wrong" },
  ])("rejects a foreign origin, host or missing session", async (supplied) => {
    const { app, service } = fixture();
    const result = await app.inject({
      method: "POST",
      url: "/testnet/relay",
      headers: supplied,
      payload: { credit_id: `0x${"b".repeat(64)}` },
    });
    expect(result.statusCode).toBe(403);
    expect(service.relay).not.toHaveBeenCalled();
    await app.close();
  });
  it("rejects arbitrary signer fields and native amounts before delegation", async () => {
    const { app, service } = fixture();
    const result = await app.inject({
      method: "POST",
      url: "/testnet/wallet",
      headers,
      payload: {
        chain: "hedera",
        to: `0x${"1".repeat(40)}`,
        data: "0x12345678",
        key: "fixture",
        label: "test",
        value: "-1",
        privateKey: "do-not-accept",
      },
    });
    expect(result.statusCode).toBe(400);
    expect(service.send).not.toHaveBeenCalled();
    await app.close();
  });
  it("delegates only a validated structured wallet request", async () => {
    const { app, service } = fixture();
    const result = await app.inject({
      method: "POST",
      url: "/testnet/wallet",
      headers,
      payload: {
        chain: "base",
        to: `0x${"1".repeat(40)}`,
        data: "0x12345678",
        key: "fixture",
        label: "test",
        value: "0",
      },
    });
    expect(result.statusCode).toBe(200);
    expect(service.send).toHaveBeenCalledWith(expect.objectContaining({ value: 0n }));
    await app.close();
  });
});
