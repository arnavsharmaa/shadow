import type { TraceSummary, TraceTotals } from "@shadow/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, json, type TestApp } from "../helpers.js";

let t: TestApp;

async function list(query: string): Promise<TraceSummary[]> {
  return json<{ items: TraceSummary[] }>(
    await t.app.inject({ url: `/api/v1/traces?limit=200${query ? `&${query}` : ""}` }),
  ).items;
}

async function totals(query: string): Promise<TraceTotals> {
  const response = await t.app.inject({ url: `/api/v1/traces/summary${query ? `?${query}` : ""}` });
  expect(response.statusCode).toBe(200);
  return json<TraceTotals>(response);
}

const sum = (items: TraceSummary[], pick: (trace: TraceSummary) => number) =>
  items.reduce((total, trace) => total + pick(trace), 0);

beforeAll(async () => {
  t = await createTestApp();
  await t.seed();
});

afterAll(async () => {
  await t.close();
});

describe("trace totals", () => {
  it("adds up exactly the traces the list returns for the same filters", async () => {
    for (const query of ["", "agent=refund-agent", "status=failed", "tool=refund_order"]) {
      const items = await list(query);
      const summary = await totals(query);
      const finished = items.filter((i) => i.status !== "running");
      expect(summary.traces).toBe(items.length);
      expect(summary.failed).toBe(items.filter((i) => i.status === "failed").length);
      expect(summary.completed).toBe(items.filter((i) => i.status === "completed").length);
      expect(summary.running).toBe(items.filter((i) => i.status === "running").length);
      expect(summary.policyViolations).toBe(
        items.filter((i) => i.outcome?.kind === "policy_violation").length,
      );
      expect(summary.totalEstimatedCost).toBeCloseTo(
        sum(items, (i) => i.metrics.totalEstimatedCost),
        8,
      );
      expect(summary.totalTokens).toBe(sum(items, (i) => i.metrics.totalTokens));
      expect(summary.modelCalls).toBe(sum(items, (i) => i.metrics.modelCalls));
      expect(summary.toolCalls).toBe(sum(items, (i) => i.metrics.toolCalls));
      expect(summary.toolErrors).toBe(sum(items, (i) => i.metrics.toolErrors));
      expect(summary.failureRate).toBeCloseTo(summary.failed / finished.length, 8);
      expect(summary.avgEstimatedCost).toBeCloseTo(summary.totalEstimatedCost / items.length, 8);
      const starts = items.map((i) => i.startedAt).sort();
      expect(summary.firstStartedAt).toBe(starts[0]);
      expect(summary.lastStartedAt).toBe(starts.at(-1));
      expect(summary.p95DurationMs ?? 0).toBeGreaterThanOrEqual(summary.avgDurationMs ?? 0);
    }
  });

  it("answers zeros and nulls for a selection that matches nothing, and validates filters", async () => {
    expect(await totals("agent=no-such-agent")).toEqual({
      traces: 0,
      running: 0,
      completed: 0,
      failed: 0,
      policyViolations: 0,
      failureRate: null,
      totalEstimatedCost: 0,
      avgEstimatedCost: null,
      totalTokens: 0,
      modelCalls: 0,
      toolCalls: 0,
      toolErrors: 0,
      avgDurationMs: null,
      p95DurationMs: null,
      firstStartedAt: null,
      lastStartedAt: null,
    });
    const bad = await t.app.inject({ url: "/api/v1/traces/summary?status=exploded" });
    expect(bad.statusCode).toBe(400);
  });
});
