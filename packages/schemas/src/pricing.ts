import { z } from "zod";

/** Price per one million tokens. */
export const modelPricingSchema = z.object({
  provider: z.string(),
  model: z.string(),
  inputPerMillion: z.number().nonnegative(),
  outputPerMillion: z.number().nonnegative(),
  cachedInputPerMillion: z.number().nonnegative().optional(),
  currency: z.string().length(3).default("USD"),
  version: z.string().default("unversioned"),
});
export type ModelPricing = z.infer<typeof modelPricingSchema>;
