import { afterEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { queue } from "../../src/shared/queue/queue.client.js";
import { HedgeJobModel } from "../../src/shared/queue/queue.model.js";
afterEach(() => vi.restoreAllMocks());
describe("retained Mongo queue ownership", () => {
  it("requires a current matching lease to complete or retry work", async () => {
    const remove = vi
      .spyOn(HedgeJobModel, "deleteOne")
      .mockResolvedValue({ deletedCount: 0 } as never);
    const update = vi
      .spyOn(HedgeJobModel, "updateOne")
      .mockResolvedValue({ modifiedCount: 0 } as never);
    expect(await queue.complete("job", "old-lease")).toBe(false);
    await queue.retry("job", "old-lease", 4);
    const filter = {
      jobId: "job",
      status: "processing",
      lease: "old-lease",
      leaseExpiresAt: { $gt: expect.any(Date) },
    };
    expect(remove).toHaveBeenCalledWith(filter);
    expect(update).toHaveBeenCalledWith(
      filter,
      expect.objectContaining({ $unset: { lease: 1, leaseExpiresAt: 1 } }),
    );
  });
  it("reports lost ownership when renewal affects no active lease", async () => {
    const update = vi
      .spyOn(HedgeJobModel, "updateOne")
      .mockResolvedValue({ modifiedCount: 0 } as never);
    expect(await queue.renew("job", "lease")).toBe(false);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "job",
        lease: "lease",
        leaseExpiresAt: { $gt: expect.any(Date) },
      }),
      expect.anything(),
    );
    update.mockResolvedValueOnce({ modifiedCount: 1 } as never);
    expect(await queue.renew("job", "lease")).toBe(true);
  });
  it("fails closed without durable storage and reuses the same fallback job identity", async () => {
    const state = vi.spyOn(mongoose.connection, "readyState", "get").mockReturnValue(0);
    await expect(
      queue.push({ kind: "loan.refresh", payload: { creditId: "loan-1" } }),
    ).rejects.toThrow("durable-queue-unavailable");
    state.mockReturnValue(1);
    const put = vi.spyOn(HedgeJobModel, "findOneAndUpdate").mockResolvedValue({} as never);
    await queue.push({ kind: "loan.refresh", payload: { creditId: "loan-1" } });
    await queue.push({ kind: "loan.refresh", payload: { creditId: "loan-1" } });
    expect(put.mock.calls[0]?.[0]).toEqual(put.mock.calls[1]?.[0]);
    expect(put.mock.calls[0]?.[1]).toHaveProperty("$setOnInsert");
  });
});
