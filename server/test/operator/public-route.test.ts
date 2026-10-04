import { describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { offerAuthorizationMessage } from "@hedge/schema";
import { testConfig } from "../../../packages/schema/test/config-fixture.js";
import { buildHedgeApp } from "../../src/app.js";
import type { OperatorRuntime } from "../../src/features/operator/operator-runtime.js";

const borrower = privateKeyToAccount(`0x${"11".repeat(32)}`);
const owner = privateKeyToAccount(`0x${"22".repeat(32)}`);
const config = { ...testConfig, operator_url: "https://operator.example/operator" };
const origin = "https://app.example";
const body = {
  request: {
    funding: {
      token: `0x${"3".repeat(40)}`,
      amount: "100000",
      recipient: { address: borrower.address, account_id: "0.0.123" },
    },
  },
  base_owner: owner.address,
};
const fixture = () => {
  const service = {
    publicProfile: { config, mode: "wallet" },
    session: "private-session",
    profile: { borrower: { address: owner.address }, session: "private-session" },
    discover: vi.fn(async () => [`0x${"4".repeat(64)}`]),
    relay: vi.fn(async () => undefined),
    send: vi.fn(),
  } as unknown as OperatorRuntime;
  return { service, app: buildHedgeApp({ operator: service, corsOrigins: [origin] }) };
};
async function signed(expires_at = Math.floor(Date.now() / 1000) + 120) {
  const message = offerAuthorizationMessage({
    ...body,
    request: { funding: { ...body.request.funding, amount: 100000n } },
    operator_url: config.operator_url,
    instance_id: config.deployment.instance_id,
    expires_at,
  });
  return {
    ...body,
    authorization: {
      expires_at,
      borrower_signature: await borrower.signMessage({ message }),
      owner_signature: await owner.signMessage({ message }),
    },
  };
}
describe("public operator boundary", () => {
  it("serves only public metadata and exposes no server wallet routes", async () => {
    const { app, service } = fixture();
    const result = await app.inject({ url: "/operator/config", headers: { origin } });
    expect(result.json()).toEqual(service.publicProfile);
    expect(result.body).not.toContain("private-session");
    for (const url of ["/operator/wallet", "/testnet/wallet"])
      expect(
        (await app.inject({ method: "POST", url, headers: { origin }, payload: {} })).statusCode,
      ).toBe(404);
    expect(service.send).not.toHaveBeenCalled();
    await app.close();
  });
  it("requests wallet authorization before publishing any offer", async () => {
    const { app, service } = fixture();
    const result = await app.inject({
      method: "POST",
      url: "/operator/offers",
      headers: { origin },
      payload: body,
    });
    expect(result.statusCode).toBe(401);
    expect(result.json().error).toBe("wallet-authorization-required");
    expect(service.discover).not.toHaveBeenCalled();
    await app.close();
  });
  it("publishes only after both wallet proofs bind the exact request", async () => {
    const { app, service } = fixture();
    const result = await app.inject({
      method: "POST",
      url: "/operator/offers",
      headers: { origin },
      payload: await signed(),
    });
    expect(result.statusCode).toBe(200);
    expect(service.discover).toHaveBeenCalledWith(
      { funding: { ...body.request.funding, amount: 100000n } },
      owner.address,
    );
    await app.close();
  });
  it.each(["amount", "owner", "signature", "expired", "future", "foreign-origin"])(
    "rejects %s before operator signing",
    async (change) => {
      const { app, service } = fixture();
      const payload = await signed(
        change === "expired"
          ? 1
          : change === "future"
            ? Math.floor(Date.now() / 1000) + 1000
            : undefined,
      );
      if (change === "amount") payload.request.funding.amount = "200000";
      if (change === "owner") payload.base_owner = borrower.address;
      if (change === "signature")
        payload.authorization.owner_signature = payload.authorization.borrower_signature;
      const result = await app.inject({
        method: "POST",
        url: "/operator/offers",
        headers: { origin: change === "foreign-origin" ? "https://hostile.example" : origin },
        payload,
      });
      expect(result.statusCode).toBe(change === "foreign-origin" ? 403 : 401);
      expect(service.discover).not.toHaveBeenCalled();
      await app.close();
    },
  );
});
