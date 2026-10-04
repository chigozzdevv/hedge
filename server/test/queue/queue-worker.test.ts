import { afterEach, describe, expect, it, vi } from "vitest";
const queue = vi.hoisted(() => ({
  claim: vi.fn(),
  renew: vi.fn(),
  complete: vi.fn(),
  retry: vi.fn(),
}));
vi.mock("../../src/shared/queue/queue.client.js", () => ({
  queue,
  duplicateRedis: vi.fn(),
  redisConnection: () => null,
}));
vi.mock("../../src/shared/logging/hedge-logger.js", () => ({ hedgeLogger: { error: vi.fn() } }));
import { drainQueue } from "../../src/shared/queue/queue.worker.js";
afterEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
});
describe("retained outbox worker", () => {
  it("does not count lost ownership as completed work", async () => {
    queue.claim
      .mockResolvedValueOnce({
        id: "job-1",
        lease: "lease-1",
        attempts: 1,
        job: { kind: "loan.refresh", payload: {} },
      })
      .mockResolvedValue(undefined);
    queue.complete.mockResolvedValue(false);
    expect(await drainQueue(async () => {}, ["loan.refresh"])).toBe(0);
    expect(queue.retry).toHaveBeenCalledWith("job-1", "lease-1", 1);
  });
  it("retries a failed handler without acknowledging the job", async () => {
    queue.claim
      .mockResolvedValueOnce({
        id: "job-1",
        lease: "lease-1",
        attempts: 2,
        job: { kind: "loan.refresh", payload: {} },
      })
      .mockResolvedValue(undefined);
    expect(
      await drainQueue(async () => {
        throw new Error("chain unavailable");
      }, ["loan.refresh"]),
    ).toBe(0);
    expect(queue.complete).not.toHaveBeenCalled();
    expect(queue.retry).toHaveBeenCalledWith("job-1", "lease-1", 2);
  });
});
