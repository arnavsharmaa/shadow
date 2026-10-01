import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { builtinPricingProvider } from "@shadow/core";
import { eventSchema, type ShadowEvent } from "@shadow/schemas";
import { describe, expect, it } from "vitest";
import { applyPricing, loadPricing, missingOpeners } from "../../src/pricing.js";

function event(partial: Record<string, unknown>): ShadowEvent {
  return eventSchema.parse({
    id: `evt_${String(partial.sequence)}`,
    traceId: "trc_1",
    branchId: "br_1",
    timestamp: "2026-10-01T09:00:00.000Z",
    name: "step",
    ...partial,
  });
}

const request = (sequence: number, spanId: string, model: string, provider = "anthropic") =>
  event({ sequence, spanId, eventType: "model.request", input: { provider, model, messages: [] } });
const response = (sequence: number, spanId: string, extra: Record<string, unknown> = {}) =>
  event({
    sequence,
    spanId,
    eventType: "model.response",
    tokenUsage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100 },
    ...extra,
  });

describe("applyPricing", () => {
  it("prices responses from the request that opened their span", () => {
    const batch = [request(0, "spn_a", "claude-sonnet-5-5"), response(1, "spn_a")];
    expect(applyPricing(builtinPricingProvider, batch)).toBe(1);
    expect(batch[1]?.estimatedCost).toEqual({
      amount: 0.003,
      currency: "USD",
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      pricingVersion: "anthropic-2026-09-25",
    });
  });

  it("leaves supplied costs, unknown models and usage-less responses alone", () => {
    const supplied = { amount: 1, currency: "USD" };
    const batch = [
      request(0, "spn_a", "claude-sonnet-5-5"),
      response(1, "spn_a", { estimatedCost: supplied }),
      request(2, "spn_b", "gpt-unknown", "openai"),
      response(3, "spn_b"),
      request(4, "spn_c", "claude-opus-5-5"),
      response(5, "spn_c", { tokenUsage: null }),
      response(6, "spn_orphan"),
      event({ sequence: 7, spanId: "spn_d", eventType: "model.request", input: "not an object" }),
      response(8, "spn_d"),
    ];
    expect(applyPricing(builtinPricingProvider, batch)).toBe(0);
    expect(batch[1]?.estimatedCost).toEqual(supplied);
    expect(batch[3]?.estimatedCost).toBeNull();
    expect(batch[5]?.estimatedCost).toBeNull();
  });

  it("uses requests stored by earlier batches and falls back to the model id", () => {
    const batch = [response(5, "spn_old")];
    expect(missingOpeners(batch)).toEqual(["spn_old"]);
    expect(missingOpeners([request(0, "spn_a", "m"), response(1, "spn_a")])).toEqual([]);
    const openers = new Map([
      ["spn_old", request(0, "spn_old", "anthropic.claude-opus-5-5", "aws.bedrock")],
    ]);
    expect(applyPricing(builtinPricingProvider, batch, openers)).toBe(1);
    expect(batch[0]?.estimatedCost?.amount).toBe(0.006);
  });
});

describe("loadPricing", () => {
  it("returns the built-in table without a file", async () => {
    const pricing = await loadPricing(undefined);
    expect(pricing.version).toBe("builtin");
    expect(pricing.lookup("anthropic", "claude-opus-5-5")?.inputPerMillion).toBe(4);
  });

  it("adds and overrides entries from a JSON file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "shadow-pricing-"));
    const file = path.join(dir, "prices.json");
    await writeFile(
      file,
      JSON.stringify([
        { provider: "openai", model: "my-model", inputPerMillion: 1, outputPerMillion: 2 },
        {
          provider: "anthropic",
          model: "claude-opus-5-5",
          inputPerMillion: 9,
          outputPerMillion: 9,
        },
      ]),
    );
    const pricing = await loadPricing(file);
    expect(pricing.version).toBe("builtin+file");
    expect(pricing.lookup("openai", "my-model")).toMatchObject({
      inputPerMillion: 1,
      currency: "USD",
      version: "unversioned",
    });
    expect(pricing.lookup("anthropic", "claude-opus-5-5")?.inputPerMillion).toBe(9);
    expect(pricing.lookup("anthropic", "claude-haiku-4-5")?.inputPerMillion).toBe(1);
  });

  it("fails loudly on unreadable or invalid files", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "shadow-pricing-"));
    await expect(loadPricing(path.join(dir, "missing.json"))).rejects.toThrow(/could not read/);
    const bad = path.join(dir, "bad.json");
    await writeFile(bad, JSON.stringify([{ provider: "x", model: "y", inputPerMillion: -1 }]));
    await expect(loadPricing(bad)).rejects.toThrow(/not a valid price list/);
  });
});
