import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentStats, ModelStats, ToolStats } from "../../src/services/stats.js";
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

describe("GET /stats/models", () => {
  it("groups model calls by provider and model with tokens and cost", async () => {
    const response = await t.app.inject({ url: "/api/v1/stats/models" });
    expect(response.statusCode, response.body).toBe(200);
    const body = json<{ items: ModelStats[] }>(response);
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    expect(body.items.every((m) => m.provider === "shadow-sim")).toBe(true);
    const large = body.items.find((m) => m.model === "sim-support-1");
    expect(large).toBeDefined();
    expect(large?.calls).toBeGreaterThan(0);
    expect(large?.traces).toBeGreaterThan(0);
    expect(large?.traces).toBeLessThanOrEqual(large?.calls ?? 0);
    expect(large?.totalTokens).toBe((large?.inputTokens ?? 0) + (large?.outputTokens ?? 0));
    expect(large?.estimatedCost).toBeGreaterThan(0);
    expect(large?.pricedCalls).toBe(large?.calls);
    expect(large?.lastUsedAt).toMatch(/^2026-/);
    // Most expensive first.
    for (let i = 1; i < body.items.length; i++) {
      expect((body.items[i - 1]?.estimatedCost ?? 0) >= (body.items[i]?.estimatedCost ?? 0)).toBe(
        true,
      );
    }
    // The agent totals add up to the agent's own usage.
    const refund = json<{ items: ModelStats[] }>(
      await t.app.inject({ url: "/api/v1/stats/models?agent=refund-agent" }),
    );
    const agents = json<Response>(await t.app.inject({ url: "/api/v1/stats/agents" }));
    const refundAgent = agents.items.find((a) => a.agentSlug === "refund-agent");
    expect(refund.items.reduce((sum, m) => sum + m.totalTokens, 0)).toBeGreaterThan(0);
    expect(refund.items.reduce((sum, m) => sum + m.traces, 0)).toBeLessThanOrEqual(
      (refundAgent?.traces ?? 0) * refund.items.length,
    );
    expect(
      json<{ items: ModelStats[] }>(
        await t.app.inject({ url: "/api/v1/stats/models?project=no-such-project" }),
      ).items,
    ).toEqual([]);
    expect((await t.app.inject({ url: "/api/v1/stats/models?from=nope" })).statusCode).toBe(400);
  });
});

describe("GET /stats/tools", () => {
  it("groups finished tool calls by tool with errors, latency and cost", async () => {
    const response = await t.app.inject({ url: "/api/v1/stats/tools" });
    expect(response.statusCode, response.body).toBe(200);
    const body = json<{ items: ToolStats[] }>(response);
    const readCustomer = body.items.find((item) => item.tool === "read_customer");
    expect(readCustomer).toBeDefined();
    expect(readCustomer?.calls).toBeGreaterThan(0);
    expect(readCustomer?.traces).toBeLessThanOrEqual(readCustomer?.calls ?? 0);
    expect(readCustomer?.avgDurationMs).not.toBeNull();
    expect(readCustomer?.p95DurationMs ?? -1).toBeGreaterThanOrEqual(0);
    expect(readCustomer?.lastUsedAt).toMatch(/^2026-/);
    for (const item of body.items) {
      expect(item.errors).toBeLessThanOrEqual(item.calls);
      expect(item.blocked).toBeLessThanOrEqual(item.errors);
      expect(item.errorRate).toBeCloseTo(item.calls === 0 ? 0 : item.errors / item.calls);
    }
    // Busiest tool first, ties by name.
    for (let i = 1; i < body.items.length; i++) {
      const previous = body.items[i - 1];
      const current = body.items[i];
      expect(previous && current && previous.calls >= current.calls).toBe(true);
    }
    // The demo refund agent is blocked by its guard policy in the seeded violation trace.
    const refund = json<{ items: ToolStats[] }>(
      await t.app.inject({ url: "/api/v1/stats/tools?agent=refund-agent" }),
    );
    expect(refund.items.length).toBeGreaterThan(0);
    expect(refund.items.length).toBeLessThanOrEqual(body.items.length);
    expect(refund.items.every((item) => body.items.some((all) => all.tool === item.tool))).toBe(
      true,
    );
    // A collection narrows both usage views to its traces.
    const created = await t.app.inject({
      method: "POST",
      url: "/api/v1/collections",
      payload: { name: "stats-usage", traceIds: ["trc_demo_refund_violation"] },
    });
    expect(created.statusCode, created.body).toBe(201);
    const collected = json<{ items: ToolStats[] }>(
      await t.app.inject({ url: "/api/v1/stats/tools?collection=stats-usage" }),
    ).items;
    expect(collected.some((item) => item.tool === "refund_order")).toBe(true);
    expect(collected.every((item) => item.traces === 1)).toBe(true);
    expect(collected.length).toBeLessThan(body.items.length);
    const collectedModels = json<{ items: ModelStats[] }>(
      await t.app.inject({ url: "/api/v1/stats/models?collection=stats-usage" }),
    ).items;
    expect(collectedModels.length).toBeGreaterThan(0);
    expect(collectedModels.every((item) => item.traces === 1)).toBe(true);
    expect(
      json<{ items: ToolStats[] }>(
        await t.app.inject({ url: "/api/v1/stats/tools?collection=no-such-collection" }),
      ).items,
    ).toEqual([]);
    await t.app.inject({ method: "DELETE", url: "/api/v1/collections/stats-usage" });
    expect(
      json<{ items: ToolStats[] }>(
        await t.app.inject({ url: "/api/v1/stats/tools?project=no-such-project" }),
      ).items,
    ).toEqual([]);
    expect((await t.app.inject({ url: "/api/v1/stats/tools?to=nope" })).statusCode).toBe(400);
  });
});

describe("usage by trace status and outcome", () => {
  const tools = async (query: string) =>
    json<{ items: ToolStats[] }>(await t.app.inject({ url: `/api/v1/stats/tools${query}` })).items;
  const models = async (query: string) =>
    json<{ items: ModelStats[] }>(await t.app.inject({ url: `/api/v1/stats/models${query}` }))
      .items;
  const listed = async (query: string) =>
    json<{ items: { id: string; status: string; outcome: { kind: string } | null }[] }>(
      await t.app.inject({ url: `/api/v1/traces?limit=200${query}` }),
    ).items;

  it("splits tool and model usage by the state of the traces", async () => {
    const allTools = await tools("");
    const allModels = await models("");
    const byStatus = {
      completed: await tools("?status=completed"),
      failed: await tools("?status=failed"),
      running: await tools("?status=running"),
    };
    // Every call belongs to a trace in exactly one state, so the three add up to the whole.
    for (const tool of allTools) {
      const calls = Object.values(byStatus).reduce(
        (sum, items) => sum + (items.find((i) => i.tool === tool.tool)?.calls ?? 0),
        0,
      );
      expect(calls, tool.tool).toBe(tool.calls);
    }
    const tokens = async (query: string) =>
      (await models(query)).reduce((sum, m) => sum + m.totalTokens, 0);
    expect(
      (await tokens("?status=completed")) +
        (await tokens("?status=failed")) +
        (await tokens("?status=running")),
    ).toBe(allModels.reduce((sum, m) => sum + m.totalTokens, 0));
    // A tool is counted in no more traces than are in that state.
    const failedTraces = await listed("&status=failed");
    expect(failedTraces.length).toBeGreaterThan(0);
    expect(byStatus.failed.length).toBeGreaterThan(0);
    for (const tool of byStatus.failed) {
      expect(tool.traces).toBeLessThanOrEqual(failedTraces.length);
    }
  });

  it("narrows tool and model usage to the traces that ended a given way", async () => {
    const violating = await listed("&outcome=policy_violation");
    expect(violating.length).toBeGreaterThan(0);
    const inViolations = await tools("?outcome=policy_violation");
    // The guard policy blocks refund_order in exactly those runs.
    const refund = inViolations.find((i) => i.tool === "refund_order");
    expect(refund?.blocked).toBeGreaterThan(0);
    expect(refund?.blocked).toBeLessThanOrEqual(
      (await tools("")).find((i) => i.tool === "refund_order")?.blocked ?? 0,
    );
    for (const tool of inViolations) expect(tool.traces).toBeLessThanOrEqual(violating.length);
    const violatingModels = await models("?outcome=policy_violation");
    expect(violatingModels.length).toBeGreaterThan(0);
    for (const model of violatingModels) {
      expect(model.traces).toBeLessThanOrEqual(violating.length);
    }

    // The outcome kinds partition the traces as well, `none` standing for no outcome.
    const kinds = [...new Set((await listed("")).map((i) => i.outcome?.kind ?? "none"))];
    let calls = 0;
    for (const kind of kinds) {
      calls += (await tools(`?outcome=${encodeURIComponent(kind)}`)).reduce(
        (sum, i) => sum + i.calls,
        0,
      );
    }
    expect(calls).toBe((await tools("")).reduce((sum, i) => sum + i.calls, 0));

    // The filters combine with each other; unknown values match nothing or are refused.
    expect(await tools("?outcome=policy_violation&status=running")).toEqual([]);
    expect(await models("?outcome=no_such_kind")).toEqual([]);
    const bad = await t.app.inject({ url: "/api/v1/stats/tools?status=exploded" });
    expect(bad.statusCode).toBe(400);
  });
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
