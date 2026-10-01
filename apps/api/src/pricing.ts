import { readFile } from "node:fs/promises";
import {
  BUILTIN_MODEL_PRICING,
  CatalogPricingProvider,
  estimateModelCost,
  type PricingProvider,
} from "@shadow/core";
import { modelPricingSchema, type ShadowEvent } from "@shadow/schemas";
import { z } from "zod";

const pricingFileSchema = z.array(modelPricingSchema).max(5000);

/**
 * The API's price table: the built-in entries plus, when `SHADOW_PRICING_FILE` is set, a JSON
 * array of `{ provider, model, inputPerMillion, outputPerMillion, cachedInputPerMillion?,
 * currency?, version? }` whose entries add to or replace the built-in ones.
 */
export async function loadPricing(file: string | undefined): Promise<CatalogPricingProvider> {
  if (!file) return new CatalogPricingProvider(BUILTIN_MODEL_PRICING, "builtin");
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new Error(
      `SHADOW_PRICING_FILE: could not read ${file}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const parsed = pricingFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `SHADOW_PRICING_FILE: ${file} is not a valid price list: ${parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return new CatalogPricingProvider([...BUILTIN_MODEL_PRICING, ...parsed.data], "builtin+file");
}

function modelOf(event: ShadowEvent): { provider: string; model: string } | null {
  const input = event.input;
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const { provider, model } = input as { provider?: unknown; model?: unknown };
  if (typeof model !== "string" || model.length === 0) return null;
  return { provider: typeof provider === "string" ? provider : "unknown", model };
}

/**
 * Estimate the cost of model responses that arrive with token usage but no cost (SDK callers
 * without a price table, OTLP spans, imported conversations). The provider and model come from
 * the `model.request` that opened the span; `openers` supplies requests stored by earlier
 * batches. Events that already carry a cost are left alone.
 */
export function applyPricing(
  pricing: PricingProvider,
  batch: ShadowEvent[],
  openers: ReadonlyMap<string, ShadowEvent> = new Map(),
): number {
  const requests = new Map(openers);
  for (const event of batch) {
    if (event.eventType === "model.request" && event.spanId) requests.set(event.spanId, event);
  }
  let priced = 0;
  for (const event of batch) {
    if (
      event.eventType !== "model.response" ||
      !event.tokenUsage ||
      event.estimatedCost ||
      !event.spanId
    ) {
      continue;
    }
    const request = requests.get(event.spanId);
    const model = request ? modelOf(request) : null;
    if (!model) continue;
    const cost = estimateModelCost(event.tokenUsage, pricing.lookup(model.provider, model.model));
    if (cost) {
      event.estimatedCost = cost;
      priced += 1;
    }
  }
  return priced;
}

/** Span ids of responses in the batch whose request is not in the batch. */
export function missingOpeners(batch: readonly ShadowEvent[]): string[] {
  const inBatch = new Set(
    batch.filter((e) => e.eventType === "model.request" && e.spanId).map((e) => e.spanId),
  );
  return [
    ...new Set(
      batch
        .filter(
          (e) =>
            e.eventType === "model.response" &&
            e.tokenUsage &&
            !e.estimatedCost &&
            e.spanId &&
            !inBatch.has(e.spanId),
        )
        .map((e) => e.spanId as string),
    ),
  ];
}
