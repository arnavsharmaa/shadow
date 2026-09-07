import type { EstimatedCost, ModelPricing, TokenUsage } from "@shadow/schemas";

export interface PricingProvider {
  lookup(provider: string, model: string): ModelPricing | undefined;
  readonly version: string;
}

/** Pricing table held in memory. Real deployments can load this from config. */
export class StaticPricingProvider implements PricingProvider {
  private readonly table = new Map<string, ModelPricing>();
  constructor(
    entries: readonly ModelPricing[],
    readonly version = "static",
  ) {
    for (const entry of entries) this.table.set(key(entry.provider, entry.model), entry);
  }
  lookup(provider: string, model: string): ModelPricing | undefined {
    return this.table.get(key(provider, model));
  }
}

function key(provider: string, model: string): string {
  return `${provider.toLowerCase()}::${model.toLowerCase()}`;
}

/** Estimated cost for a completion; returns null when pricing is unknown. */
export function estimateModelCost(
  usage: TokenUsage,
  pricing: ModelPricing | undefined,
): EstimatedCost | null {
  if (!pricing) return null;
  const cached = usage.cachedInputTokens ?? 0;
  const uncachedInput = Math.max(0, usage.inputTokens - cached);
  const cachedRate = pricing.cachedInputPerMillion ?? pricing.inputPerMillion;
  const amount =
    (uncachedInput * pricing.inputPerMillion +
      cached * cachedRate +
      usage.outputTokens * pricing.outputPerMillion) /
    1_000_000;
  return {
    amount: roundMoney(amount),
    currency: pricing.currency,
    provider: pricing.provider,
    model: pricing.model,
    pricingVersion: pricing.version,
  };
}

export function roundMoney(amount: number): number {
  return Math.round(amount * 1e8) / 1e8;
}

/**
 * Fictional pricing for the bundled deterministic simulator model. These
 * numbers are invented for the demo and are not a real vendor's prices.
 */
export const SIMULATED_MODEL_PRICING: ModelPricing[] = [
  {
    provider: "shadow-sim",
    model: "sim-support-1",
    inputPerMillion: 2.5,
    outputPerMillion: 10,
    currency: "USD",
    version: "sim-2026.1",
  },
  {
    provider: "shadow-sim",
    model: "sim-support-mini",
    inputPerMillion: 0.4,
    outputPerMillion: 1.6,
    currency: "USD",
    version: "sim-2026.1",
  },
];

export const defaultPricingProvider = new StaticPricingProvider(
  SIMULATED_MODEL_PRICING,
  "sim-2026.1",
);
