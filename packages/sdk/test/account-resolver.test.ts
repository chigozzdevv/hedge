import { afterEach, describe, expect, it, vi } from "vitest";
import { createAccountResolver } from "../src/evm/account-resolver";

const address = `0x${"Ab".repeat(20)}`;
const numericAddress = "0x000000000000000000000000000000000000007b";
const account = { account: "0.0.123", evm_address: address.toLowerCase(), deleted: false };
const reply = (body: unknown) => new Response(JSON.stringify(body));

afterEach(() => vi.unstubAllGlobals());

describe("Hedera account resolution", () => {
  it("verifies an alias and shares concurrent lookups across address casing", async () => {
    const fetchAccount = vi.fn<typeof fetch>(async () => reply(account));
    vi.stubGlobal("fetch", fetchAccount);
    const resolve = createAccountResolver("https://mirror.example/");
    await expect(Promise.all([resolve(address), resolve(address.toLowerCase())])).resolves.toEqual([
      "0.0.123",
      "0.0.123",
    ]);
    expect(fetchAccount).toHaveBeenCalledTimes(1);
    expect(fetchAccount.mock.calls[0][0]).toBe(
      `https://mirror.example/api/v1/accounts/${address.toLowerCase()}`,
    );
  });
  it("verifies a numeric account address even when the account also has an EVM alias", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply(account)),
    );
    await expect(createAccountResolver("https://mirror.example")(numericAddress)).resolves.toBe(
      "0.0.123",
    );
  });
  it("verifies numeric accounts without an EVM alias", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply({ ...account, evm_address: null })),
    );
    await expect(createAccountResolver("https://mirror.example")(numericAddress)).resolves.toBe(
      "0.0.123",
    );
  });
  it.each([
    { ...account, deleted: true },
    { ...account, deleted: "false" },
    { ...account, account: "1.0.123" },
    { ...account, account: "invalid" },
    { ...account, evm_address: 123 },
    { ...account, evm_address: `0x${"1".repeat(40)}` },
    null,
  ])("rejects deleted, malformed or unrelated account identities: %j", async (body) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply(body)),
    );
    await expect(createAccountResolver("https://mirror.example")(address)).rejects.toMatchObject({
      code: "WALLET_MISMATCH",
    });
  });
  it("allows recovery after a failed lookup without caching that failure", async () => {
    const fetchAccount = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(reply(account));
    vi.stubGlobal("fetch", fetchAccount);
    const resolve = createAccountResolver("https://mirror.example");
    await expect(resolve(address)).rejects.toMatchObject({ code: "WALLET_UNAVAILABLE" });
    await expect(resolve(address)).resolves.toBe("0.0.123");
    expect(fetchAccount).toHaveBeenCalledTimes(2);
  });
});
