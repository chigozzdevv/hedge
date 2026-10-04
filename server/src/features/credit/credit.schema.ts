import { z } from "zod";
import { idSchema, creditSummarySchema } from "@hedge/schema";
export { creditSummarySchema };
export const creditParamsSchema = z.strictObject({ id: idSchema });
export const creditTrackSchema = z.strictObject({ creditId: idSchema });
