import { describe, expect, it, vi } from "vitest";
import { generateBindings } from "../src/generate-bindings";

describe("contract artifact registration", () => {
  it("exports no protocol ABI for an empty registry", async () => {
    const reader = vi.fn();
    const files = await generateBindings([], reader);
    expect(reader).not.toHaveBeenCalled();
    expect([...files.keys()]).toEqual(["index.ts"]);
    expect(files.get("index.ts")).toContain("export {};");
  });
  it.each([
    [{ name: "../../outside", artifact: "loan.sol/Loan.json" }],
    [{ name: "loan", artifact: "../../secret.json" }],
    [{ name: "loan", artifact: "/loan.sol/Loan.json" }],
    [{ name: "loan", artifact: "loan.sol/Loan.json", address: "copied" }],
  ])("rejects invalid registrations before reading files: %j", async (entry) => {
    const reader = vi.fn();
    await expect(generateBindings([entry], reader)).rejects.toThrow();
    expect(reader).not.toHaveBeenCalled();
  });
  it("rejects duplicate names and artifacts without an ABI", async () => {
    const entry = { name: "loan", artifact: "loan.sol/Loan.json" };
    await expect(
      generateBindings([entry, entry], async () => ({
        abi: [{ type: "function", name: "repay" }],
      })),
    ).rejects.toThrow("Duplicate");
    await expect(generateBindings([entry], async () => ({ abi: [] }))).rejects.toThrow("no ABI");
  });
  it("derives exports only from registered compiler artifacts", async () => {
    const abi = [{ type: "function", name: "repay", inputs: [], outputs: [] }];
    const files = await generateBindings(
      [{ name: "hedera-loan", artifact: "loan.sol/Loan.json" }],
      async () => ({ abi }),
    );
    expect(files.get("hedera-loan.ts")).toContain("export const hederaLoanAbi");
    expect(files.get("hedera-loan.ts")).toContain('"repay"');
    expect(files.get("index.ts")).toContain('export * from "./hedera-loan"');
  });
  it("rejects names that overwrite the index or collide after identifier conversion", async () => {
    const reader = async () => ({ abi: [{ type: "function", name: "repay" }] });
    await expect(
      generateBindings([{ name: "index", artifact: "loan.sol/Loan.json" }], reader),
    ).rejects.toThrow("Reserved");
    await expect(
      generateBindings(
        [
          { name: "loan-1", artifact: "loan.sol/Loan.json" },
          { name: "loan1", artifact: "loan.sol/Loan.json" },
        ],
        reader,
      ),
    ).rejects.toThrow("Colliding");
  });
});
