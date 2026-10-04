import { afterEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { HedgeChainClient } from "../../src/shared/chain/hedge.client.js";
import { createCreditService } from "../../src/features/credit/credit.service.js";
import { createCreditWorker } from "../../src/features/credit/credit.worker.js";
import { createCollateralService } from "../../src/features/collateral/collateral.service.js";
import { createCollateralWorker } from "../../src/features/collateral/collateral.worker.js";
import * as queueWorker from "../../src/shared/queue/queue.worker.js";
import { makeReader, manifest } from "./hedge-reader.fixture.js";

afterEach(() => vi.restoreAllMocks());
for (const kind of ["credit.tracked", "collateral.tracked"] as const) {
  describe(kind, () => {
    function worker() {
      const chain = new HedgeChainClient({ manifest, reader: makeReader() });
      return kind === "credit.tracked"
        ? createCreditWorker(createCreditService(chain), manifest.instance_id)
        : createCollateralWorker(createCollateralService(chain), manifest.instance_id);
    }
    it("rejects a job from another instance before reading chain state", async () => {
      vi.spyOn(queueWorker, "drainQueue").mockImplementation(async (handle) => {
        await handle({ kind, payload: { instanceId: "other", creditId: "loan-1" } });
        return 1;
      });
      await expect(worker().run()).rejects.toThrow("job-instance-mismatch");
    });
    it("fails refresh work when durable storage is unavailable", async () => {
      vi.spyOn(mongoose.connection, "readyState", "get").mockReturnValue(0);
      vi.spyOn(queueWorker, "drainQueue").mockImplementation(async (handle) => {
        await handle({ kind, payload: { instanceId: manifest.instance_id, creditId: "loan-1" } });
        return 1;
      });
      await expect(worker().run()).rejects.toThrow("tracking-storage-unavailable");
    });
  });
}
