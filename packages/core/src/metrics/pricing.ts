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

const ANTHROPIC_PRICING_VERSION = "anthropic-2026-09-25";

function anthropic(
  model: string,
  inputPerMillion: number,
  outputPerMillion: number,
  cachedInputPerMillion = roundMoney(inputPerMillion * 0.1),
): ModelPricing {
  return {
    provider: "anthropic",
    model,
    inputPerMillion,
    outputPerMillion,
    cachedInputPerMillion,
    currency: "USD",
    version: ANTHROPIC_PRICING_VERSION,
  };
}

/**
 * Anthropic first-party API list prices in USD per million tokens, as published on
 * 2026-09-25. Cache reads use the published rate where one is listed and the standard 0.1x
 * input multiplier otherwise. Prices change and partner platforms (Bedrock, Vertex AI) price
 * separately, so costs stay estimates; override entries with `SHADOW_PRICING_FILE`.
 */
export const ANTHROPIC_MODEL_PRICING: ModelPricing[] = [
  anthropic("claude-fable-5-1", 10, 50, 0.25),
  anthropic("claude-fable-5", 10, 50),
  anthropic("claude-opus-5-5", 4, 20, 0.2),
  anthropic("claude-opus-5", 5, 25),
  anthropic("claude-opus-4-8", 5, 25),
  anthropic("claude-opus-4-7", 5, 25),
  anthropic("claude-opus-4-6", 5, 25),
  anthropic("claude-sonnet-5-5", 2, 10, 0.2),
  anthropic("claude-sonnet-5", 2, 10),
  anthropic("claude-sonnet-4-6", 3, 15),
  anthropic("claude-haiku-4-5", 1, 5),
];

/**
 * Canonical form of a model id for price lookups: lower case, without a platform prefix
 * (`anthropic.claude-…` on Bedrock) and without a dated snapshot suffix (`-20251101`,
 * `@20251101`).
 */
export function normalizeModelId(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/^[a-z0-9-]+\./, "")
    .replace(/[-@]\d{8}$/, "");
}

/**
 * A price table for traces recorded outside the engine, where model ids come from other
 * systems. Lookups try the exact provider/model pair, then the normalised model id, and, when
 * the provider is unknown to the table, the model id alone if exactly one provider lists it.
 * Later entries replace earlier ones with the same provider and model.
 */
export class CatalogPricingProvider implements PricingProvider {
  private readonly table = new Map<string, ModelPricing>();
  private readonly byModel = new Map<string, ModelPricing[]>();
  private readonly providers = new Set<string>();

  constructor(
    entries: readonly ModelPricing[],
    readonly version = "catalog",
  ) {
    for (const entry of entries) this.table.set(key(entry.provider, entry.model), entry);
    for (const entry of this.table.values()) {
      this.providers.add(entry.provider.toLowerCase());
      const model = entry.model.toLowerCase();
      this.byModel.set(model, [...(this.byModel.get(model) ?? []), entry]);
    }
  }

  lookup(provider: string, model: string): ModelPricing | undefined {
    const normalized = normalizeModelId(model);
    const exact = this.table.get(key(provider, model)) ?? this.table.get(key(provider, normalized));
    if (exact || this.providers.has(provider.trim().toLowerCase())) return exact;
    const candidates = this.byModel.get(model.trim().toLowerCase()) ?? this.byModel.get(normalized);
    return candidates?.length === 1 ? candidates[0] : undefined;
  }

  /** Every entry, sorted by provider then model. */
  list(): ModelPricing[] {
    return [...this.table.values()].sort(
      (a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model),
    );
  }
}

/** The simulator's fictional prices plus the Anthropic list prices. */
export const BUILTIN_MODEL_PRICING: ModelPricing[] = [
  ...SIMULATED_MODEL_PRICING,
  ...ANTHROPIC_MODEL_PRICING,
];

export const builtinPricingProvider = new CatalogPricingProvider(
  BUILTIN_MODEL_PRICING,
  `builtin-${ANTHROPIC_PRICING_VERSION}`,
);
