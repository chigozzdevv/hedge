import { testRecord } from "../../schema/test/config-fixture";
import { describe, expect, it, vi } from "vitest";
import { loadHedgeConfig, type ClientConfig } from "../src";

// Public evidence from the existing deployment. These tests perform no chain execution.
import { deploymentConfigSchema } from "@hedge/schema";

const record = structuredClone(testRecord);
const config: ClientConfig = deploymentConfigSchema.parse(record);
const transport = (response: Response) => vi.fn<typeof fetch>(async () => response);

describe("generated public config loading", () => {
  it("resolves a deployment reference relative to the supplied config URL", async () => {
    const settings = {
      deployment_file: "deployments/testnet.json",
      operator: config.operator,
      rpc: config.rpc,
      mirror_url: config.mirror_url,
      operator_url: "https://my-app.example/hedge",
    };
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(settings))
      .mockResolvedValueOnce(Response.json(record));
    expect(
      await loadHedgeConfig("https://my-app.example/config/hedge.config.json", request),
    ).toEqual({ ...config, operator_url: settings.operator_url });
    expect(request.mock.calls[1][0]).toBe("https://my-app.example/config/deployments/testnet.json");
  });
  it("rejects private paths and altered deployment evidence", async () => {
    const settings = {
      deployment_file: ".hedge/wallets.json",
      operator: config.operator,
      rpc: config.rpc,
      mirror_url: config.mirror_url,
      operator_url: config.operator_url,
    };
    const request = transport(Response.json(settings));
    await expect(loadHedgeConfig(undefined, request)).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
    expect(request).toHaveBeenCalledTimes(1);
    const altered = {
      ...record,
      verification: {
        ...record.verification,
        base: { ...record.verification.base, code_hash: `0x${"0".repeat(64)}` },
      },
    };
    const invalid = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ ...settings, deployment_file: "deployments/testnet.json" }),
      )
      .mockResolvedValueOnce(Response.json(altered));
    await expect(loadHedgeConfig(undefined, invalid)).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
  });
  it("loads the default public URL without caching deployment settings", async () => {
    const request = transport(Response.json(config));
    expect(await loadHedgeConfig(undefined, request)).toEqual(config);
    expect(request).toHaveBeenCalledWith("/hedge.config.json", {
      cache: "no-store",
      signal: undefined,
    });
  });
  it("validates and detaches an explicitly supplied config without HTTP", async () => {
    const request = vi.fn<typeof fetch>();
    const loaded = await loadHedgeConfig(config, request);
    loaded.rpc.base = "https://other.example";
    expect(config.rpc.base).toBe("http://fixture.invalid");
    expect(request).not.toHaveBeenCalled();
  });
  it("reports a missing config instead of guessing contract addresses", async () => {
    await expect(
      loadHedgeConfig(undefined, transport(new Response(null, { status: 404 }))),
    ).rejects.toMatchObject({ code: "CONFIG_MISSING" });
  });
  it("reports failed HTTP and network access", async () => {
    await expect(
      loadHedgeConfig(undefined, transport(new Response(null, { status: 503 }))),
    ).rejects.toMatchObject({ code: "CONFIG_UNAVAILABLE" });
    await expect(
      loadHedgeConfig(
        undefined,
        vi.fn<typeof fetch>(async () => {
          throw new Error("Offline");
        }),
      ),
    ).rejects.toMatchObject({ code: "CONFIG_UNAVAILABLE" });
  });
  it("rejects an HTML response, malformed JSON and incomplete config", async () => {
    for (const body of ["<html>404</html>", "{", JSON.stringify({ deployment: config.deployment })])
      await expect(loadHedgeConfig(undefined, transport(new Response(body)))).rejects.toMatchObject(
        { code: "CONFIG_INVALID" },
      );
  });
  it("rejects secrets, non-HTTP endpoints and malformed deployment boundaries", async () => {
    for (const candidate of [
      { ...config, session: "should-not-be-public" },
      { ...config, operator_url: "https://user:password@example.com" },
      { ...config, operator_url: "https://example.com?session=test-secret" },
      { ...config, rpc: { ...config.rpc, base: "https://example.com#test-secret" } },
      { ...config, rpc: { ...config.rpc, base: "javascript:alert(1)" } },
      { ...config, start_block: { ...config.start_block, hedera: "-1" } },
      {
        ...config,
        deployment: {
          ...config.deployment,
          base: { ...config.deployment.base, contract: "missing" },
        },
      },
    ])
      await expect(loadHedgeConfig(candidate as ClientConfig)).rejects.toMatchObject({
        code: "CONFIG_INVALID",
      });
  });
  it("preserves caller cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      loadHedgeConfig(
        undefined,
        async () => {
          throw controller.signal.reason;
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
