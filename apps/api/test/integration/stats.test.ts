import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentStats } from "../../src/services/stats.js";
import { createTestApp, json, type TestApp } from "../helpers.js";

interface Response {
  from: string | null;
  to: string | null;
  items: AgentStats[];
}

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
  await t.seed();
});

afterAll(async () => {
  await t.close();
});

describe("GET /stats/agents", () => {
  it("aggregates the seeded traces per agent", async () => {
    const response = await t.app.inject({ method: "GET", url: "/api/v1/stats/agents" });
    expect(response.statusCode).toBe(200);
    const body = json<Response>(response);
    expect(body.from).toBeNull();
    expect(body.items.length).toBeGreaterThanOrEqual(3);
    expect(body.items.reduce((sum, a) => sum + a.traces, 0)).toBe(7);
    // Sorted by volume, then slug.
    for (let i = 1; i < body.items.length; i++) {
      const prev = body.items[i - 1] as AgentStats;
      const cur = body.items[i] as AgentStats;
      expect(prev.traces >= cur.traces).toBe(true);
    }
    const refund = body.items.find((a) => a.agentSlug === "refund-agent");
    expect(refund).toBeDefined();
    expect(refund?.projectSlug).toBe("support-agent");
    expect(refund?.policyViolations).toBeGreaterThanOrEqual(1);
    expect(refund?.failed).toBeGreaterThanOrEqual(refund?.policyViolations ?? 0);
    expect(
      refund?.completed ?? 0 + (refund?.failed ?? 0) + (refund?.running ?? 0),
    ).toBeLessThanOrEqual(refund?.traces ?? 0);
    expect(refund?.totalEstimatedCost).toBeGreaterThan(0);
    expect(refund?.totalTokens).toBeGreaterThan(0);
    expect(refund?.avgDurationMs).toBeGreaterThan(0);
    expect(refund?.p95DurationMs).toBeGreaterThanOrEqual(refund?.avgDurationMs ?? 0);
    expect(refund?.lastStartedAt).toMatch(/^2026-/);
  });

  it("honours time range and project filters", async () => {
    const future = json<Response>(
      await t.app.inject({
        method: "GET",
        url: "/api/v1/stats/agents?from=2030-01-01T00:00:00Z",
      }),
    );
    expect(future.items).toEqual([]);
    expect(future.from).toBe("2030-01-01T00:00:00Z");

    const project = json<Response>(
      await t.app.inject({ method: "GET", url: "/api/v1/stats/agents?project=support-agent" }),
    );
    expect(project.items.length).toBeGreaterThan(0);
    expect(project.items.every((a) => a.projectSlug === "support-agent")).toBe(true);

    const invalid = await t.app.inject({
      method: "GET",
      url: "/api/v1/stats/agents?from=yesterday",
    });
    expect(invalid.statusCode).toBe(400);
  });
});
