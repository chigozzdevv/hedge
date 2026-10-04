import { afterEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { creditRepo } from "../../src/features/credit/credit.repo.js";
import { HedgeCreditModel } from "../../src/features/credit/credit.model.js";
import { credit, observed, hash } from "../chain/hedge-reader.fixture.js";
afterEach(() => vi.restoreAllMocks());
describe("adapted credit projection", () => {
  it("scopes the cached loan to its deployment and guards block/hash ordering", async () => {
    vi.spyOn(mongoose.connection, "readyState", "get").mockReturnValue(1);
    const save = vi.spyOn(HedgeCreditModel, "findOneAndUpdate").mockResolvedValue({} as never);
    await creditRepo.save(observed(credit));
    expect(save).toHaveBeenCalledWith(
      {
        _id: JSON.stringify(["fixture", "loan-1"]),
        $or: [{ observedBlock: { $lt: 100 } }, { observedBlock: 100, observedHash: hash }],
      },
      expect.objectContaining({
        $set: expect.objectContaining({
          snapshot: expect.objectContaining({ amount_due: "1010000" }),
        }),
      }),
      { upsert: true },
    );
  });
  it("ignores an older racing read but rejects a conflicting hash at the same block", async () => {
    vi.spyOn(mongoose.connection, "readyState", "get").mockReturnValue(1);
    const conflict = Object.assign(new Error("duplicate"), { code: 11000 });
    vi.spyOn(HedgeCreditModel, "findOneAndUpdate").mockRejectedValue(conflict);
    const read = vi
      .spyOn(HedgeCreditModel, "findById")
      .mockReturnValue({ lean: async () => ({ observedBlock: 101, observedHash: hash }) } as never);
    await expect(creditRepo.save(observed(credit))).resolves.toBe(true);
    read.mockReturnValue({
      lean: async () => ({ observedBlock: 100, observedHash: `0x${"3".repeat(64)}` }),
    } as never);
    await expect(creditRepo.save(observed(credit))).rejects.toBe(conflict);
  });
});
