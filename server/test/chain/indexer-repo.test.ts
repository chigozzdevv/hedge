import { afterEach, describe, expect, it, vi } from "vitest";
import { hedgeIndexerRepo } from "../../src/shared/chain/indexer.repo.js";
import { HedgeEventModel, HedgeIndexCursorModel } from "../../src/shared/chain/indexer.model.js";
afterEach(() => vi.restoreAllMocks());
describe("retained index storage", () => {
  it("never advances after losing its lease", async () => {
    const update = vi
      .spyOn(HedgeIndexCursorModel, "updateOne")
      .mockResolvedValue({ modifiedCount: 0 } as never);
    await expect(
      hedgeIndexerRepo.advance("instance:base:vault", "old-lease", 10n, "hash"),
    ).rejects.toThrow("indexer-lease-lost");
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: "instance:base:vault",
        lease: "old-lease",
        leaseExpiresAt: { $gt: expect.any(Date) },
      }),
      expect.anything(),
    );
  });
  it("stores duplicate event delivery with an insert-only upsert", async () => {
    const update = vi
      .spyOn(HedgeEventModel, "updateOne")
      .mockResolvedValue({ modifiedCount: 0 } as never);
    await hedgeIndexerRepo.record("same-event", { chainId: 84532 });
    await hedgeIndexerRepo.record("same-event", { chainId: 84532 });
    expect(update).toHaveBeenCalledWith(
      { _id: "same-event" },
      { $setOnInsert: { chainId: 84532 } },
      { upsert: true },
    );
  });
});
