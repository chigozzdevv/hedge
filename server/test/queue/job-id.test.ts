import { describe, expect, it } from "vitest";
import { hedgeJobId } from "../../src/shared/queue/job-id.js";
describe("Hedge job identity", () => {
  it("keeps reordered fields stable without merging separate operations on one loan", () => {
    const a = {
      kind: "ccip.delivery",
      payload: { creditId: "loan-1", instance: "hedge-1", message: "message-1" },
    };
    expect(hedgeJobId(a)).toBe(
      hedgeJobId({
        ...a,
        payload: { message: "message-1", instance: "hedge-1", creditId: "loan-1" },
      }),
    );
    expect(hedgeJobId(a)).not.toBe(
      hedgeJobId({ ...a, payload: { ...a.payload, message: "message-2" } }),
    );
    expect(hedgeJobId(a)).not.toBe(
      hedgeJobId({ ...a, payload: { ...a.payload, instance: "hedge-2" } }),
    );
  });
  it("supports explicit operation identity without conflating job kinds", () => {
    const a = {
      kind: "loan.refresh",
      payload: { observation: 1 },
      idempotencyKey: "instance-1:loan-1:observation-1",
    };
    expect(hedgeJobId(a)).toBe(hedgeJobId({ ...a, payload: { observation: 2 } }));
    expect(hedgeJobId(a)).not.toBe(hedgeJobId({ ...a, kind: "ccip.delivery" }));
  });
  it("rejects empty explicit identities and invalid queue names", () => {
    expect(() => hedgeJobId({ kind: "loan.refresh", payload: {}, idempotencyKey: "" })).toThrow(
      "job-invalid",
    );
    expect(() => hedgeJobId({ kind: "loan:refresh", payload: {} })).toThrow("job-invalid");
  });
});
