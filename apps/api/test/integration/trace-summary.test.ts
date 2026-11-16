import type { TraceSummary, TraceTotals, TraceTotalsBreakdown } from "@shadow/schemas";
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

async function breakdown(query: string): Promise<TraceTotalsBreakdown> {
  const response = await t.app.inject({ url: `/api/v1/traces/summary?${query}` });
  expect(response.statusCode).toBe(200);
  return json<TraceTotalsBreakdown>(response);
}

/** Two sets of totals over the same traces: counts exactly, sums and latency within rounding. */
function expectSameTotals(actual: TraceTotals, expected: TraceTotals): void {
  for (const field of [
    "traces",
    "running",
    "completed",
    "failed",
    "policyViolations",
    "totalTokens",
    "modelCalls",
    "toolCalls",
    "toolErrors",
  ] as const) {
    expect(actual[field], field).toBe(expected[field]);
  }
  expect(actual.totalEstimatedCost).toBeCloseTo(expected.totalEstimatedCost, 8);
  expect(actual.avgEstimatedCost ?? -1).toBeCloseTo(expected.avgEstimatedCost ?? -1, 8);
  expect(actual.failureRate ?? -1).toBeCloseTo(expected.failureRate ?? -1, 8);
  expect(actual.avgDurationMs ?? -1).toBeCloseTo(expected.avgDurationMs ?? -1, 4);
  expect(actual.p95DurationMs ?? -1).toBeCloseTo(expected.p95DurationMs ?? -1, 4);
  expect(actual.firstStartedAt).toBe(expected.firstStartedAt);
  expect(actual.lastStartedAt).toBe(expected.lastStartedAt);
}

beforeAll(async () => {
  t = await createTestApp();
  await t.seed();
});

afterAll(async () => {
  await t.close();
});

describe("trace totals", () => {
  it("adds up exactly the traces the list returns for the same filters", async () => {
    for (const query of [
      "",
      "agent=refund-agent",
      "status=failed",
      "tool=refund_order",
      "outcome=policy_violation",
    ]) {
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

  it("breaks the totals down by agent, project, status or outcome, largest group first", async () => {
    const all = await totals("");
    for (const groupBy of ["agent", "project", "status", "outcome"] as const) {
      const answer = await breakdown(`groupBy=${groupBy}`);
      const groups = answer.groups ?? [];
      expect(groups.length).toBeGreaterThan(0);
      // The overall totals are unchanged and the groups partition them.
      expectSameTotals(answer, all);
      expect(groups.reduce((total, group) => total + group.traces, 0)).toBe(all.traces);
      expect(new Set(groups.map((group) => group.key)).size).toBe(groups.length);
      const sizes = groups.map((group) => group.traces);
      expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
      // Each group is what filtering by its key adds up to.
      for (const group of groups) {
        expectSameTotals(group, await totals(`${groupBy}=${encodeURIComponent(group.key)}`));
      }
    }
  });

  it("breaks the totals down by UTC day, oldest first, within the other filters", async () => {
    const all = await totals("");
    const days = (await breakdown("groupBy=day")).groups ?? [];
    expect(days.length).toBeGreaterThan(0);
    expect(days.reduce((total, day) => total + day.traces, 0)).toBe(all.traces);
    const keys = days.map((day) => day.key);
    for (const key of keys) expect(key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(keys).toEqual([...keys].sort());
    expect(keys[0]).toBe(all.firstStartedAt?.slice(0, 10));
    expect(keys.at(-1)).toBe(all.lastStartedAt?.slice(0, 10));
    for (const day of days) {
      const from = encodeURIComponent(`${day.key}T00:00:00.000Z`);
      const to = encodeURIComponent(`${day.key}T23:59:59.999Z`);
      expectSameTotals(day, await totals(`from=${from}&to=${to}`));
    }

    // The breakdown stays inside the selection.
    const failed = await breakdown("status=failed&groupBy=agent");
    const failedGroups = failed.groups ?? [];
    expect(failedGroups.length).toBeGreaterThan(0);
    expect(failedGroups.reduce((total, group) => total + group.traces, 0)).toBe(failed.traces);
    for (const group of failedGroups) expect(group.failed).toBe(group.traces);

    // Nothing matching is an empty breakdown; an unknown dimension is refused.
    expect((await breakdown("agent=no-such-agent&groupBy=status")).groups).toEqual([]);
    const bad = await t.app.inject({ url: "/api/v1/traces/summary?groupBy=tag" });
    expect(bad.statusCode).toBe(400);
  });

  it("serves the totals, or a breakdown, as CSV", async () => {
    const csv = async (query: string) => {
      const response = await t.app.inject({ url: `/api/v1/traces/summary?format=csv${query}` });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/csv");
      expect(response.headers["content-disposition"]).toContain("shadow-trace-summary.csv");
      return response.body.split("\r\n").filter((line) => line.length > 0);
    };

    // Without a breakdown: one row for everything the filters match.
    const failed = await totals("status=failed");
    const whole = await csv("&status=failed");
    expect(whole[0]).toBe(
      "group,traces,running,completed,failed,policyViolations,failureRate,totalEstimatedCost,avgEstimatedCost,totalTokens,modelCalls,toolCalls,toolErrors,avgDurationMs,p95DurationMs,firstStartedAt,lastStartedAt",
    );
    expect(whole).toHaveLength(2);
    const cells = (whole[1] ?? "").split(",");
    expect(cells.slice(0, 6)).toEqual([
      "all",
      String(failed.traces),
      "0",
      "0",
      String(failed.failed),
      String(failed.policyViolations),
    ]);
    expect(Number(cells[7])).toBeCloseTo(failed.totalEstimatedCost, 8);
    expect(cells.at(-1)).toBe(failed.lastStartedAt);

    // With one: the first column is named after the dimension, one row per group in order.
    for (const groupBy of ["agent", "outcome", "day"] as const) {
      const groups = (await breakdown(`groupBy=${groupBy}`)).groups ?? [];
      const lines = await csv(`&groupBy=${groupBy}`);
      expect(lines[0]?.startsWith(`${groupBy},traces,running,`)).toBe(true);
      expect(lines.slice(1).map((line) => line.split(",")[0])).toEqual(groups.map((g) => g.key));
      expect(lines.slice(1).map((line) => Number(line.split(",")[1]))).toEqual(
        groups.map((g) => g.traces),
      );
    }

    // Values that cannot be computed are empty cells; an empty breakdown is only the header.
    expect((await csv("&agent=no-such-agent"))[1]).toBe("all,0,0,0,0,0,,0,,0,0,0,0,,,,");
    expect(await csv("&agent=no-such-agent&groupBy=status")).toHaveLength(1);
    const bad = await t.app.inject({ url: "/api/v1/traces/summary?format=xml" });
    expect(bad.statusCode).toBe(400);
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
