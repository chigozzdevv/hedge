import { z } from "zod";
import { idSchema } from "@hedge/schema";
export { collateralSchema, type CollateralSummary } from "../../shared/chain/hedge.schema.js";
export const collateralParamsSchema = z.strictObject({ id: idSchema });
export const collateralTrackSchema = z.strictObject({ creditId: idSchema });
