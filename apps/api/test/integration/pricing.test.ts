import type { ModelPricing, ShadowEvent, TraceSummary } from "@shadow/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, json, listAllEvents, type TestApp } from "../helpers.js";

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await t.close();
});

async function ingest(traceId: string, events: Record<string, unknown>[]): Promise<void> {
  const response = await t.app.inject({
    method: "POST",
    url: `/api/v1/traces/${traceId}/events`,
    payload: { events },
  });
  expect(response.statusCode, response.body).toBe(201);
}

describe("cost estimation on ingestion", () => {
  it("prices model responses that arrive without a cost, across batches", async () => {
    const created = await t.app.inject({
      method: "POST",
      url: "/api/v1/traces",
      payload: { project: "p", agent: "sdk-agent", name: "priced" },
    });
    const { id } = json<{ id: string }>(created);
    await ingest(id, [
      { eventType: "trace.started", name: "trace.started" },
      {
        eventType: "model.request",
        name: "plan",
        spanId: "spn_plan",
        input: { provider: "anthropic", model: "claude-haiku-4-5-20251001", messages: [] },
      },
    ]);
    // The response arrives in a later batch; its request is looked up in storage.
    await ingest(id, [
      {
        eventType: "model.response",
        name: "plan",
        spanId: "spn_plan",
        output: { message: { role: "assistant", content: "ok" } },
        tokenUsage: {
          inputTokens: 2000,
          outputTokens: 500,
          totalTokens: 2500,
          cachedInputTokens: 1000,
        },
      },
      {
        eventType: "model.request",
        name: "answer",
        spanId: "spn_answer",
        input: { provider: "acme", model: "acme-large", messages: [] },
      },
      {
        eventType: "model.response",
        name: "answer",
        spanId: "spn_answer",
        tokenUsage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
      },
      {
        eventType: "model.request",
        name: "own-cost",
        spanId: "spn_own",
        input: { provider: "anthropic", model: "claude-opus-5-5", messages: [] },
      },
      {
        eventType: "model.response",
        name: "own-cost",
        spanId: "spn_own",
        tokenUsage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
        estimatedCost: { amount: 0.5, currency: "USD" },
      },
    ]);
    const events = await listAllEvents(t, id);
    const cost = (name: string) =>
      events.find((e: ShadowEvent) => e.eventType === "model.response" && e.name === name)
        ?.estimatedCost;
    // 1000 uncached at $1/M + 1000 cached at $0.10/M + 500 output at $5/M
    expect(cost("plan")).toEqual({
      amount: 0.0036,
      currency: "USD",
      provider: "anthropic",
      model: "claude-haiku-4-5",
      pricingVersion: "anthropic-2026-09-25",
    });
    expect(cost("answer")).toBeNull();
    expect(cost("own-cost")).toEqual({ amount: 0.5, currency: "USD" });

    const detail = json<{ trace: TraceSummary }>(
      await t.app.inject({ url: `/api/v1/traces/${id}` }),
    );
    expect(detail.trace.metrics.totalEstimatedCost).toBeCloseTo(0.5036, 6);
  });

  it("lists the price table", async () => {
    const response = await t.app.inject({ url: "/api/v1/pricing" });
    expect(response.statusCode).toBe(200);
    const body = json<{ version: string; items: ModelPricing[] }>(response);
    expect(body.version).toBe("builtin-anthropic-2026-09-25");
    expect(body.items.find((p) => p.model === "claude-opus-5-5")).toMatchObject({
      provider: "anthropic",
      inputPerMillion: 4,
      outputPerMillion: 20,
      cachedInputPerMillion: 0.2,
    });
    expect(body.items.some((p) => p.provider === "shadow-sim")).toBe(true);
  });
});
