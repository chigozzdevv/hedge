import { z } from "zod";
import { idSchema } from "@hedge/schema";
import { drainQueue, registerHandler, type Handler } from "../../shared/queue/queue.worker.js";
import type { CollateralService } from "./collateral.service.js";
const payloadSchema = z.strictObject({ instanceId: idSchema, creditId: idSchema });
export function createCollateralWorker(service: CollateralService, instanceId: string) {
  const handle: Handler = async (job) => {
    if (job.kind !== "collateral.tracked") throw new Error("job-kind-invalid");
    const payload = payloadSchema.parse(job.payload);
    if (payload.instanceId !== instanceId) throw new Error("job-instance-mismatch");
    await service.refresh(payload.creditId, { requireStorage: true });
  };
  return {
    register() {
      registerHandler(["collateral.tracked"], handle);
    },
    run() {
      return drainQueue(handle, ["collateral.tracked"]);
    },
  };
}
