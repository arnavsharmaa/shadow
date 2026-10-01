import type { ModelPricing } from "@shadow/schemas";
import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_MODEL_PRICING,
  CatalogPricingProvider,
  SIMULATED_MODEL_PRICING,
  StaticPricingProvider,
  builtinPricingProvider,
  normalizeModelId,
  aggregateMetrics,
  defaultPricingProvider,
  estimateModelCost,
  roundMoney,
} from "../src/index.js";
import { makeEvent } from "./helpers.js";

const pricing: ModelPricing = {
  provider: "acme",
  model: "Acme-Large",
  inputPerMillion: 10,
  outputPerMillion: 30,
  cachedInputPerMillion: 1,
  currency: "EUR",
  version: "2026.1",
};

describe("StaticPricingProvider", () => {
  it("looks up entries case-insensitively and reports its version", () => {
    const provider = new StaticPricingProvider([pricing], "test-v1");
    expect(provider.version).toBe("test-v1");
    expect(provider.lookup("ACME", "acme-large")).toBe(pricing);
    expect(provider.lookup("acme", "Acme-Large")).toBe(pricing);
    expect(provider.lookup("acme", "other")).toBeUndefined();
    expect(provider.lookup("other", "Acme-Large")).toBeUndefined();
  });

  it("defaults its version to 'static'", () => {
    expect(new StaticPricingProvider([]).version).toBe("static");
  });

  it("ships the simulated pricing table as the default provider", () => {
    expect(defaultPricingProvider.version).toBe("sim-2026.1");
    for (const entry of SIMULATED_MODEL_PRICING) {
      expect(defaultPricingProvider.lookup(entry.provider, entry.model)).toEqual(entry);
    }
    expect(defaultPricingProvider.lookup("shadow-sim", "does-not-exist")).toBeUndefined();
  });
});

describe("CatalogPricingProvider", () => {
  it("normalises platform prefixes and dated snapshots", () => {
    expect(normalizeModelId("Claude-Opus-5-5")).toBe("claude-opus-5-5");
    expect(normalizeModelId("anthropic.claude-opus-5-5")).toBe("claude-opus-5-5");
    expect(normalizeModelId("claude-opus-4-5-20251101")).toBe("claude-opus-4-5");
    expect(normalizeModelId("claude-opus-4-5@20251101")).toBe("claude-opus-4-5");
    expect(normalizeModelId(" sim-support-1 ")).toBe("sim-support-1");
  });

  it("finds Anthropic prices by exact id, Bedrock id and snapshot id", () => {
    const opus = builtinPricingProvider.lookup("anthropic", "claude-opus-5-5");
    expect(opus).toMatchObject({
      inputPerMillion: 4,
      outputPerMillion: 20,
      cachedInputPerMillion: 0.2,
      currency: "USD",
      version: "anthropic-2026-09-25",
    });
    expect(builtinPricingProvider.lookup("anthropic", "anthropic.claude-opus-5-5")).toBe(opus);
    expect(builtinPricingProvider.lookup("Anthropic", "claude-opus-5-5-20260901")).toBe(opus);
    // Cache reads default to a tenth of the input price where no rate is published.
    expect(builtinPricingProvider.lookup("anthropic", "claude-haiku-4-5")).toMatchObject({
      inputPerMillion: 1,
      outputPerMillion: 5,
      cachedInputPerMillion: 0.1,
    });
    expect(builtinPricingProvider.lookup("anthropic", "claude-unknown-9")).toBeUndefined();
    expect(builtinPricingProvider.version).toBe("builtin-anthropic-2026-09-25");
  });

  it("falls back to the model id only when the provider is unknown to the table", () => {
    const opus = builtinPricingProvider.lookup("anthropic", "claude-opus-5-5");
    expect(builtinPricingProvider.lookup("unknown", "claude-opus-5-5")).toBe(opus);
    expect(builtinPricingProvider.lookup("aws.bedrock", "anthropic.claude-opus-5-5")).toBe(opus);
    // A known provider never borrows another provider's price.
    expect(builtinPricingProvider.lookup("shadow-sim", "claude-opus-5-5")).toBeUndefined();
    const ambiguous = new CatalogPricingProvider([
      { ...pricing, provider: "a", model: "shared" },
      { ...pricing, provider: "b", model: "shared" },
    ]);
    expect(ambiguous.lookup("c", "shared")).toBeUndefined();
    expect(ambiguous.version).toBe("catalog");
  });

  it("lets later entries override earlier ones and lists the table sorted", () => {
    const custom = { ...pricing, provider: "anthropic", model: "claude-opus-5-5", version: "mine" };
    const provider = new CatalogPricingProvider([...ANTHROPIC_MODEL_PRICING, custom], "v");
    expect(provider.lookup("anthropic", "claude-opus-5-5")).toBe(custom);
    const listed = provider.list();
    expect(listed).toHaveLength(ANTHROPIC_MODEL_PRICING.length);
    expect(listed.map((e) => e.model)).toEqual([...listed.map((e) => e.model)].sort());
    expect(builtinPricingProvider.list().map((e) => e.provider)).toContain("shadow-sim");
  });
});

describe("estimateModelCost", () => {
  it("returns null when pricing is unknown", () => {
    expect(
      estimateModelCost({ inputTokens: 10, outputTokens: 10, totalTokens: 20 }, undefined),
    ).toBeNull();
  });

  it("charges input and output tokens at their per-million rates", () => {
    const cost = estimateModelCost(
      { inputTokens: 1_000_000, outputTokens: 500_000, totalTokens: 1_500_000 },
      pricing,
    );
    expect(cost).toEqual({
      amount: 25,
      currency: "EUR",
      provider: "acme",
      model: "Acme-Large",
      pricingVersion: "2026.1",
    });
  });

  it("charges cached input tokens at the cached rate", () => {
    const cost = estimateModelCost(
      {
        inputTokens: 1_000_000,
        cachedInputTokens: 400_000,
        outputTokens: 0,
        totalTokens: 1_000_000,
      },
      pricing,
    );
    // 600k uncached * 10 + 400k cached * 1 = 6.4
    expect(cost?.amount).toBe(6.4);
  });

  it("falls back to the input rate when no cached rate is configured and never goes negative", () => {
    const noCached: ModelPricing = { ...pricing, cachedInputPerMillion: undefined };
    const cost = estimateModelCost(
      { inputTokens: 100, cachedInputTokens: 500, outputTokens: 0, totalTokens: 100 },
      noCached,
    );
    // All 100 input tokens are treated as cached at the input rate; the excess is ignored.
    expect(cost?.amount).toBe(roundMoney((500 * 10) / 1_000_000));
    expect(cost?.amount).toBeGreaterThan(0);
  });

  it("rounds to 8 decimal places", () => {
    expect(roundMoney(0.123456789123)).toBe(0.12345679);
    expect(roundMoney(0)).toBe(0);
    const cost = estimateModelCost({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }, pricing);
    expect(cost?.amount).toBe(0.00004);
  });
});

describe("aggregateMetrics", () => {
  it("returns empty metrics for no events", () => {
    const metrics = aggregateMetrics([]);
    expect(metrics.eventCount).toBe(0);
    expect(metrics.durationMs).toBe(0);
    expect(metrics.totalEstimatedCost).toBe(0);
    expect(metrics.currency).toBe("USD");
  });

  it("counts calls, sums tokens, splits cost by model/tool and measures the timestamp range", () => {
    const events = [
      makeEvent({
        sequence: 0,
        eventType: "trace.started",
        name: "t",
        timestamp: "2026-01-01T00:00:00.000Z",
      }),
      makeEvent({
        sequence: 1,
        eventType: "model.request",
        name: "m",
        timestamp: "2026-01-01T00:00:01.000Z",
      }),
      makeEvent({
        sequence: 2,
        eventType: "model.response",
        name: "m",
        timestamp: "2026-01-01T00:00:02.000Z",
        tokenUsage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
        estimatedCost: { amount: 0.001, currency: "USD" },
      }),
      makeEvent({
        sequence: 3,
        eventType: "tool.request",
        name: "a",
        timestamp: "2026-01-01T00:00:03.000Z",
      }),
      makeEvent({
        sequence: 4,
        eventType: "tool.response",
        name: "a",
        timestamp: "2026-01-01T00:00:04.000Z",
        estimatedCost: { amount: 0.05, currency: "USD" },
      }),
      makeEvent({
        sequence: 5,
        eventType: "tool.request",
        name: "b",
        timestamp: "2026-01-01T00:00:05.000Z",
      }),
      makeEvent({
        sequence: 6,
        eventType: "tool.error",
        name: "b",
        timestamp: "2026-01-01T00:00:06.000Z",
      }),
      makeEvent({
        sequence: 7,
        eventType: "policy.evaluated",
        name: "p",
        timestamp: "2026-01-01T00:00:07.000Z",
      }),
      makeEvent({
        sequence: 8,
        eventType: "model.request",
        name: "m2",
        timestamp: "2026-01-01T00:00:08.000Z",
        tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      }),
      makeEvent({
        sequence: 9,
        eventType: "trace.completed",
        name: "t",
        timestamp: "2026-01-01T00:00:10.500Z",
      }),
    ];
    const metrics = aggregateMetrics(events);
    expect(metrics).toEqual({
      eventCount: 10,
      modelCalls: 2,
      toolCalls: 2,
      toolErrors: 1,
      policyEvaluations: 1,
      inputTokens: 101,
      outputTokens: 21,
      totalTokens: 122,
      estimatedModelCost: 0.001,
      estimatedToolCost: 0.05,
      totalEstimatedCost: 0.051,
      durationMs: 10_500,
      currency: "USD",
      firstTimestamp: "2026-01-01T00:00:00.000Z",
      lastTimestamp: "2026-01-01T00:00:10.500Z",
    });
  });

  it("uses the timestamp range even when events are out of order and ignores unparseable timestamps", () => {
    const events = [
      makeEvent({ sequence: 1, timestamp: "2026-01-01T00:00:05.000Z" }),
      makeEvent({ sequence: 0, timestamp: "2026-01-01T00:00:01.000Z" }),
      makeEvent({ sequence: 2, timestamp: "not-a-date" }),
    ];
    expect(aggregateMetrics(events).durationMs).toBe(4000);
  });

  it("adopts the currency of cost-bearing events and avoids floating point drift", () => {
    const events = Array.from({ length: 10 }, (_, i) =>
      makeEvent({
        sequence: i,
        eventType: "tool.response",
        name: "t",
        estimatedCost: { amount: 0.1, currency: "EUR" },
      }),
    );
    const metrics = aggregateMetrics(events);
    expect(metrics.currency).toBe("EUR");
    expect(metrics.estimatedToolCost).toBe(1);
    expect(metrics.totalEstimatedCost).toBe(1);
  });
});
