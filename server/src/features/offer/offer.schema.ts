import { z } from "zod";
import { idSchema, offerSchema } from "@hedge/schema";
export { offerSchema };
export const offerParamsSchema = z.strictObject({ id: idSchema });
