import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentTrend, Overview } from "../../src/services/stats.js";
import { createTestApp, json, type TestApp } from "../helpers.js";

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
  await t.seed();
});

afterAll(async () => {
  await t.close();
});

async function trend(query: string): Promise<AgentTrend> {
  const response = await t.app.inject({
    url: `/api/v1/stats/agents/refund-agent/timeseries?${query}`,
  });
  expect(response.statusCode, response.body).toBe(200);
  return json<AgentTrend>(response);
}

describe("GET /stats/agents/:agentSlug/timeseries", () => {
  it("buckets an agent's traces by UTC day with empty days filled in", async () => {
    const body = await trend(
      "bucket=day&from=2026-08-31T00:00:00.000Z&to=2026-09-03T12:00:00.000Z&project=support-agent",
    );
    expect(body).toMatchObject({
      agent: "refund-agent",
      project: "support-agent",
      bucket: "day",
      from: "2026-08-31T00:00:00.000Z",
      to: "2026-09-04T00:00:00.000Z",
    });
    expect(body.points.map((p) => p.start)).toEqual([
      "2026-08-31T00:00:00.000Z",
      "2026-09-01T00:00:00.000Z",
      "2026-09-02T00:00:00.000Z",
      "2026-09-03T00:00:00.000Z",
    ]);
    const [before, violation, enterprise, after] = body.points;
    expect(before).toMatchObject({ traces: 0, avgDurationMs: null, totalEstimatedCost: 0 });
    expect(violation).toMatchObject({ traces: 1, failed: 1, policyViolations: 1 });
    expect(violation?.totalEstimatedCost).toBeGreaterThan(0);
    expect(violation?.totalTokens).toBeGreaterThan(0);
    expect(violation?.p95DurationMs).toBeGreaterThan(0);
    expect(enterprise).toMatchObject({ traces: 1, completed: 1, failed: 0 });
    expect(after?.traces).toBe(0);
  });

  it("supports hourly buckets and a default range ending now", async () => {
    const hourly = await trend(
      "bucket=hour&from=2026-09-01T08:30:00.000Z&to=2026-09-01T10:59:59.000Z",
    );
    expect(hourly.points.map((p) => [p.start, p.traces])).toEqual([
      ["2026-09-01T08:00:00.000Z", 0],
      ["2026-09-01T09:00:00.000Z", 1],
      ["2026-09-01T10:00:00.000Z", 0],
    ]);
    expect((await trend("")).points).toHaveLength(31);
    expect((await trend("bucket=hour")).points).toHaveLength(49);
  });

  it("rejects unknown agents and oversized or inverted ranges", async () => {
    const missing = await t.app.inject({ url: "/api/v1/stats/agents/nobody/timeseries" });
    expect(missing.statusCode).toBe(404);
    const wrongProject = await t.app.inject({
      url: "/api/v1/stats/agents/refund-agent/timeseries?project=elsewhere",
    });
    expect(wrongProject.statusCode).toBe(404);
    const tooMany = await t.app.inject({
      url: "/api/v1/stats/agents/refund-agent/timeseries?bucket=hour&from=2026-01-01T00:00:00.000Z&to=2026-09-01T00:00:00.000Z",
    });
    expect(tooMany.statusCode).toBe(400);
    const inverted = await t.app.inject({
      url: "/api/v1/stats/agents/refund-agent/timeseries?from=2026-09-02T00:00:00.000Z&to=2026-09-01T00:00:00.000Z",
    });
    expect(inverted.statusCode).toBe(400);
    const badBucket = await t.app.inject({
      url: "/api/v1/stats/agents/refund-agent/timeseries?bucket=week",
    });
    expect(badBucket.statusCode).toBe(400);
  });
});

describe("GET /stats/overview", () => {
  it("summarises a window, the window before it and the daily series across agents", async () => {
    const response = await t.app.inject({
      url: "/api/v1/stats/overview?days=3&to=2026-09-03T00:00:00.000Z",
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = json<Overview>(response);
    expect(body).toMatchObject({
      from: "2026-08-31T00:00:00.000Z",
      to: "2026-09-03T00:00:00.000Z",
      previousFrom: "2026-08-28T00:00:00.000Z",
    });
    expect(body.totals.traces).toBe(7);
    expect(body.totals.failed).toBeGreaterThanOrEqual(1);
    expect(body.totals.failureRate).toBeCloseTo(body.totals.failed / 7, 6);
    expect(body.totals.policyViolations).toBeGreaterThanOrEqual(1);
    expect(body.totals.totalEstimatedCost).toBeGreaterThan(0);
    expect(body.totals.p95DurationMs).toBeGreaterThan(0);
    expect(body.totals.agents).toBeGreaterThanOrEqual(3);
    expect(body.previous).toMatchObject({ traces: 0, failed: 0, failureRate: null, agents: 0 });
    // One point per day the window touches, in order, adding up to every trace.
    expect(body.daily.map((p) => p.start)).toEqual([
      "2026-08-31T00:00:00.000Z",
      "2026-09-01T00:00:00.000Z",
      "2026-09-02T00:00:00.000Z",
      "2026-09-03T00:00:00.000Z",
    ]);
    expect(body.daily.reduce((sum, p) => sum + p.traces, 0)).toBe(7);
    expect(body.topAgents.length).toBeGreaterThanOrEqual(3);
    expect(body.topAgents.length).toBeLessThanOrEqual(5);
    expect(body.topAgents[0]?.traces).toBeGreaterThanOrEqual(body.topAgents[1]?.traces ?? 0);

    const scoped = json<Overview>(
      await t.app.inject({
        url: "/api/v1/stats/overview?days=3&to=2026-09-03T00:00:00.000Z&project=support-agent",
      }),
    );
    expect(scoped.totals.traces).toBeLessThan(7);
    expect(scoped.topAgents.every((a) => a.projectSlug === "support-agent")).toBe(true);
    expect(scoped.daily.reduce((sum, p) => sum + p.traces, 0)).toBe(scoped.totals.traces);

    expect((await t.app.inject({ url: "/api/v1/stats/overview?days=0" })).statusCode).toBe(400);
    expect((await t.app.inject({ url: "/api/v1/stats/overview" })).statusCode).toBe(200);
  });
});
