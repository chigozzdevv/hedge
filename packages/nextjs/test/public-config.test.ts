import { testConfig, testRecord } from "../../schema/test/config-fixture";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "../src/app/hedge.config.json/route";

const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("node:fs/promises", () => ({ readFile: mocks.read }));
const config = structuredClone(testConfig);
const settings = {
  deployment_file: "deployments/testnet.json",
  operator: config.operator,
  operator_url: config.operator_url,
  rpc: config.rpc,
  mirror_url: config.mirror_url,
};
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

describe("root public config endpoint", () => {
  it("loads app settings and the repository deployment from the Next.js workspace", async () => {
    vi.stubEnv("HEDGE_APP_DIR", "/projects/hedge/packages/nextjs");
    vi.stubEnv("HEDGE_DEPLOYMENT_ROOT", undefined);
    mocks.read.mockImplementation(async (path: string) =>
      JSON.stringify(path.endsWith("hedge.config.json") ? settings : testRecord),
    );
    expect((await GET()).status).toBe(200);
    expect(mocks.read).toHaveBeenCalledWith(
      "/projects/hedge/packages/nextjs/.hedge/hedge.config.json",
      "utf8",
    );
    expect(mocks.read).toHaveBeenCalledWith("/projects/hedge/deployments/testnet.json", "utf8");
  });
  it("serves validated connection details without caching a stale config", async () => {
    mocks.read.mockImplementation(async (path: string) =>
      JSON.stringify(path.endsWith("hedge.config.json") ? settings : testRecord),
    );
    const first = await GET();
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(await first.json()).toEqual(config);
    const changed = { ...settings, operator_url: "https://operator.example/hedge" };
    mocks.read.mockImplementation(async (path: string) =>
      JSON.stringify(path.endsWith("hedge.config.json") ? changed : testRecord),
    );
    expect(await (await GET()).json()).toEqual({ ...config, operator_url: changed.operator_url });
  });
  it("reports missing config so the SDK can display setup instructions", async () => {
    mocks.read.mockRejectedValue(Object.assign(new Error("Missing file"), { code: "ENOENT" }));
    const response = await GET();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "hedge-config-missing" });
  });
  it.each([
    "{",
    JSON.stringify({ ...settings, private_key: "test-secret" }),
    JSON.stringify({ ...settings, operator_url: "https://user:test-secret@example.com" }),
  ])(
    "rejects invalid or credential-bearing config without exposing its contents",
    async (value) => {
      mocks.read.mockResolvedValue(value);
      const response = await GET();
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "hedge-config-invalid" });
    },
  );
});
