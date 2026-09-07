import type { TraceSummary } from "@shadow/schemas";
import { DEMO_TRACE_IDS, demoTraces } from "@shadow/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, json, type ErrorEnvelope, type TestApp } from "../helpers.js";

interface TraceList {
  items: TraceSummary[];
  nextCursor: string | null;
  total: number;
}

describe("trace listing", () => {
  let t: TestApp;
  let all: TraceSummary[];

  async function list(query = ""): Promise<TraceList> {
    const response = await t.app.inject({
      method: "GET",
      url: `/api/v1/traces${query ? `?${query}` : ""}`,
    });
    if (response.statusCode !== 200) throw new Error(response.body);
    return json<TraceList>(response);
  }

  const ids = (result: TraceList) => result.items.map((i) => i.id);

  beforeAll(async () => {
    t = await createTestApp();
    const report = await t.seed();
    expect(report.seeded).toHaveLength(demoTraces.length);
    all = (await list("limit=200")).items;
  });

  afterAll(async () => {
    await t.close();
  });

  it("lists every demo trace newest first with a total", async () => {
    const result = await list();
    expect(result.total).toBe(demoTraces.length);
    expect(result.items).toHaveLength(demoTraces.length);
    expect(result.nextCursor).toBeNull();
    const startedAt = result.items.map((i) => Date.parse(i.startedAt));
    for (let i = 1; i < startedAt.length; i++)
      expect(startedAt[i - 1]).toBeGreaterThanOrEqual(startedAt[i] ?? 0);
    expect(result.items[0]?.id).toBe(DEMO_TRACE_IDS.faqSecond);
    const summary = result.items.find((i) => i.id === DEMO_TRACE_IDS.refundViolation);
    expect(summary).toMatchObject({
      projectSlug: "support-agent",
      projectName: "Support Agent",
      agentSlug: "refund-agent",
      agentName: "Refund Agent",
      status: "failed",
      branchCount: 2,
    });
    expect(summary?.outcome?.kind).toBe("policy_violation");
    expect(summary?.metrics.toolCalls).toBeGreaterThan(0);
  });

  it("filters by project and agent", async () => {
    expect(ids(await list("project=fulfilment"))).toEqual([DEMO_TRACE_IDS.inventoryTimeout]);
    expect(ids(await list("project=sales-ops"))).toEqual([DEMO_TRACE_IDS.enrichmentExpensive]);
    const support = await list("project=support-agent");
    expect(support.total).toBe(5);
    expect(support.items.every((i) => i.projectSlug === "support-agent")).toBe(true);

    const refunds = await list("agent=refund-agent");
    expect(refunds.total).toBe(2);
    expect(ids(refunds).sort()).toEqual(
      [DEMO_TRACE_IDS.refundEnterprise, DEMO_TRACE_IDS.refundViolation].sort(),
    );
    expect(ids(await list("agent=support-faq-agent&project=support-agent"))).toEqual([
      DEMO_TRACE_IDS.faqSecond,
      DEMO_TRACE_IDS.faqSuccess,
    ]);
    expect((await list("agent=refund-agent&project=fulfilment")).total).toBe(0);
    expect((await list("project=unknown")).total).toBe(0);
  });

  it("filters by status", async () => {
    const failed = await list("status=failed");
    expect(failed.items.every((i) => i.status === "failed")).toBe(true);
    expect(ids(failed)).toContain(DEMO_TRACE_IDS.refundViolation);
    const completed = await list("status=completed");
    expect(completed.items.every((i) => i.status === "completed")).toBe(true);
    expect(ids(completed)).toContain(DEMO_TRACE_IDS.faqSuccess);
    const running = await list("status=running");
    expect(failed.total + completed.total + running.total).toBe(demoTraces.length);
    expect(
      (await t.app.inject({ method: "GET", url: "/api/v1/traces?status=weird" })).statusCode,
    ).toBe(400);
  });

  it("filters by tag", async () => {
    const refund = await list("tag=refund");
    expect(refund.total).toBe(2);
    expect(refund.items.every((i) => i.tags.includes("refund"))).toBe(true);
    expect((await list("tag=demo")).total).toBe(demoTraces.length);
    expect((await list("tag=nope")).total).toBe(0);
  });

  it("filters by tool", async () => {
    const refunded = await list("tool=refund_order");
    expect(ids(refunded).sort()).toEqual(
      [DEMO_TRACE_IDS.refundEnterprise, DEMO_TRACE_IDS.refundViolation].sort(),
    );
    expect(ids(await list("tool=inventory.lookup"))).toEqual([DEMO_TRACE_IDS.inventoryTimeout]);
    expect((await list("tool=does_not_exist")).total).toBe(0);
  });

  it("searches ids, metadata values and tool names with q", async () => {
    expect(ids(await list("q=cus_1001"))).toEqual([DEMO_TRACE_IDS.refundViolation]);
    expect(ids(await list("q=CUS_1001"))).toEqual([DEMO_TRACE_IDS.refundViolation]);
    expect(ids(await list("q=cus_4410")).sort()).toEqual(
      [DEMO_TRACE_IDS.faqSecond, DEMO_TRACE_IDS.faqSuccess].sort(),
    );
    expect(ids(await list(`q=${DEMO_TRACE_IDS.inventoryTimeout}`))).toEqual([
      DEMO_TRACE_IDS.inventoryTimeout,
    ]);
    expect(ids(await list("q=trc_demo_faq")).sort()).toEqual(
      [DEMO_TRACE_IDS.faqSecond, DEMO_TRACE_IDS.faqSuccess].sort(),
    );
    expect(ids(await list("q=refund_order")).sort()).toEqual(
      [DEMO_TRACE_IDS.refundEnterprise, DEMO_TRACE_IDS.refundViolation].sort(),
    );
    expect(ids(await list("q=TCK-20931"))).toEqual([DEMO_TRACE_IDS.refundViolation]);
    expect((await list("q=zzz_no_such_token")).total).toBe(0);
    expect((await list("q=100%25")).total).toBe(0);
  });

  it("filters by minimum cost and duration", async () => {
    const costs = all.map((i) => i.metrics.totalEstimatedCost);
    const maxCost = Math.max(...costs);
    expect(maxCost).toBeGreaterThan(0);
    const expensive = await list(`minCost=${maxCost}`);
    expect(expensive.total).toBe(costs.filter((c) => c >= maxCost).length);
    expect(expensive.items.every((i) => i.metrics.totalEstimatedCost >= maxCost)).toBe(true);
    expect((await list("minCost=0")).total).toBe(demoTraces.length);
    expect((await list(`minCost=${maxCost + 1}`)).total).toBe(0);

    const durations = all.map((i) => i.durationMs ?? 0);
    const threshold = [...durations].sort((a, b) => a - b)[Math.floor(durations.length / 2)] ?? 0;
    expect(threshold).toBeGreaterThan(0);
    const slow = await list(`minDurationMs=${threshold}`);
    expect(slow.total).toBe(durations.filter((d) => d >= threshold).length);
    expect(slow.items.every((i) => (i.durationMs ?? 0) >= threshold)).toBe(true);
    expect(
      (await t.app.inject({ method: "GET", url: "/api/v1/traces?minCost=-1" })).statusCode,
    ).toBe(400);
  });

  it("filters by start time window", async () => {
    const recent = await list("from=2026-09-02T00:00:00.000Z");
    expect(ids(recent).sort()).toEqual(
      [DEMO_TRACE_IDS.faqSecond, DEMO_TRACE_IDS.refundEnterprise].sort(),
    );
    const early = await list("to=2026-09-01T12:00:00.000Z");
    expect(ids(early).sort()).toEqual(
      [
        DEMO_TRACE_IDS.refundViolation,
        DEMO_TRACE_IDS.inventoryTimeout,
        DEMO_TRACE_IDS.faqSuccess,
      ].sort(),
    );
    const window = await list("from=2026-09-01T10:00:00.000Z&to=2026-09-01T13:00:00.000Z");
    expect(ids(window).sort()).toEqual(
      [
        DEMO_TRACE_IDS.inventoryTimeout,
        DEMO_TRACE_IDS.faqSuccess,
        DEMO_TRACE_IDS.enrichmentExpensive,
      ].sort(),
    );
    expect(
      (await t.app.inject({ method: "GET", url: "/api/v1/traces?from=today" })).statusCode,
    ).toBe(400);
  });

  it("sorts by cost, tokens, duration and name in both directions", async () => {
    const desc = await list("sort=totalEstimatedCost&order=desc");
    const descCosts = desc.items.map((i) => i.metrics.totalEstimatedCost);
    for (let i = 1; i < descCosts.length; i++)
      expect(descCosts[i - 1]).toBeGreaterThanOrEqual(descCosts[i] ?? 0);
    expect(desc.items[0]?.id).toBe(DEMO_TRACE_IDS.enrichmentExpensive);

    const asc = await list("sort=totalEstimatedCost&order=asc");
    const ascCosts = asc.items.map((i) => i.metrics.totalEstimatedCost);
    for (let i = 1; i < ascCosts.length; i++)
      expect(ascCosts[i - 1]).toBeLessThanOrEqual(ascCosts[i] ?? 0);

    const tokens = (await list("sort=totalTokens&order=desc")).items.map(
      (i) => i.metrics.totalTokens,
    );
    for (let i = 1; i < tokens.length; i++)
      expect(tokens[i - 1]).toBeGreaterThanOrEqual(tokens[i] ?? 0);

    const durations = (await list("sort=durationMs&order=asc")).items.map((i) => i.durationMs ?? 0);
    for (let i = 1; i < durations.length; i++)
      expect(durations[i - 1]).toBeLessThanOrEqual(durations[i] ?? 0);

    const names = (await list("sort=name&order=asc")).items.map((i) => i.name);
    expect(names).toEqual([...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    expect(
      (await t.app.inject({ method: "GET", url: "/api/v1/traces?sort=color" })).statusCode,
    ).toBe(400);
  });

  it("pages with limit and cursor while keeping the total", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: TraceList = await list(`limit=3${cursor ? `&cursor=${cursor}` : ""}`);
      expect(page.total).toBe(demoTraces.length);
      expect(page.items.length).toBeLessThanOrEqual(3);
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(demoTraces.length);
    expect(seen).toEqual(all.map((i) => i.id));

    const filteredPage = await list("tag=refund&limit=1");
    expect(filteredPage.total).toBe(2);
    expect(filteredPage.items).toHaveLength(1);
    expect(filteredPage.nextCursor).toEqual(expect.any(String));
    const rest = await list(`tag=refund&limit=1&cursor=${filteredPage.nextCursor ?? ""}`);
    expect(rest.items).toHaveLength(1);
    expect(rest.nextCursor).toBeNull();
    expect(rest.items[0]?.id).not.toBe(filteredPage.items[0]?.id);

    const invalid = await t.app.inject({ method: "GET", url: "/api/v1/traces?cursor=!!!" });
    expect(invalid.statusCode).toBe(400);
    expect(json<ErrorEnvelope>(invalid).error.message).toBe("invalid cursor");
    expect(
      (await t.app.inject({ method: "GET", url: "/api/v1/traces?limit=201" })).statusCode,
    ).toBe(400);
  });

  it("exposes facets for the explorer", async () => {
    const response = await t.app.inject({ method: "GET", url: "/api/v1/traces/facets" });
    expect(response.statusCode).toBe(200);
    const facets = json<{
      projects: { slug: string; name: string }[];
      agents: { slug: string; name: string; projectSlug: string }[];
      tags: string[];
      tools: string[];
    }>(response);
    expect(facets.projects.map((p) => p.slug).sort()).toEqual([
      "fulfilment",
      "sales-ops",
      "support-agent",
    ]);
    expect(facets.agents).toContainEqual({
      slug: "refund-agent",
      name: "Refund Agent",
      projectSlug: "support-agent",
    });
    expect(facets.agents).toContainEqual(
      expect.objectContaining({ slug: "inventory-agent", projectSlug: "fulfilment" }),
    );
    expect(facets.tags).toEqual([...new Set(demoTraces.flatMap((d) => d.tags))].sort());
    expect(facets.tools).toEqual(
      expect.arrayContaining(["refund_order", "read_customer", "inventory.lookup", "send_email"]),
    );
    expect(facets.tools).toEqual([...facets.tools].sort());
    expect(new Set(facets.tools).size).toBe(facets.tools.length);
  });
});
