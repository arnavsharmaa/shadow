import type { Branch, Comparison, TraceSummary } from "@shadow/schemas";
import { DEMO_TRACE_IDS, demoTraces } from "@shadow/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isDatabaseEmpty, seedDemoData } from "../../src/seed/seed.js";
import { createTestApp, json, type TestApp } from "../helpers.js";

describe("demo seed", () => {
  let t: TestApp;
  let firstForkIds: Map<string, string>;

  const branchesOf = async (traceId: string) =>
    json<{ trace: TraceSummary; branches: Branch[] }>(
      await t.app.inject({ method: "GET", url: `/api/v1/traces/${traceId}` }),
    );

  async function forkIds(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const spec of demoTraces.filter((s) => s.fork)) {
      const { branches } = await branchesOf(spec.traceId);
      out.set(spec.traceId, branches.map((b) => b.id).join(","));
    }
    return out;
  }

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  it("seeds every demo trace into an empty database", async () => {
    expect(await isDatabaseEmpty(t.services)).toBe(true);
    const report = await seedDemoData(t.services);
    expect(report.seeded).toEqual(demoTraces.map((s) => s.traceId));
    expect(report.skipped).toEqual([]);
    expect(await isDatabaseEmpty(t.services)).toBe(false);

    const list = json<{ total: number }>(
      await t.app.inject({ method: "GET", url: "/api/v1/traces" }),
    );
    expect(list.total).toBe(demoTraces.length);

    const refund = await branchesOf(DEMO_TRACE_IDS.refundViolation);
    expect(refund.trace.branchCount).toBe(2);
    expect(refund.branches.map((b) => b.name).sort()).toEqual(["fork-1", "main"]);
    const main = refund.branches.find((b) => b.name === "main");
    const fork = refund.branches.find((b) => b.name === "fork-1");
    expect(main?.id).toBe("br_demo_refund_violation_main");
    expect(fork?.parentBranchId).toBe("br_demo_refund_violation_main");
    expect(fork?.status).toBe("completed");
    expect(fork?.outcome?.kind).toBe("approval_pending");
    const comparisons = json<{ items: Comparison[] }>(
      await t.app.inject({
        method: "GET",
        url: `/api/v1/comparisons?traceId=${DEMO_TRACE_IDS.refundViolation}`,
      }),
    );
    expect(comparisons.items).toHaveLength(1);
    expect(comparisons.items[0]?.result.outcome.changed).toBe(true);

    const inventory = await branchesOf(DEMO_TRACE_IDS.inventoryTimeout);
    expect(inventory.trace.branchCount).toBe(2);
    expect(inventory.trace.projectSlug).toBe("fulfilment");
    const faq = await branchesOf(DEMO_TRACE_IDS.faqSuccess);
    expect(faq.trace.branchCount).toBe(1);
    firstForkIds = await forkIds();
  });

  it("skips traces that already exist", async () => {
    const report = await t.seed();
    expect(report.seeded).toEqual([]);
    expect(report.skipped).toEqual(demoTraces.map((s) => s.traceId));
    const list = json<{ total: number }>(
      await t.app.inject({ method: "GET", url: "/api/v1/traces" }),
    );
    expect(list.total).toBe(demoTraces.length);
    expect((await branchesOf(DEMO_TRACE_IDS.refundViolation)).trace.branchCount).toBe(2);
    expect(await forkIds()).toEqual(firstForkIds);
  });

  it("re-creates the data set with force", async () => {
    const report = await seedDemoData(t.services, { force: true });
    expect(report.seeded).toEqual(demoTraces.map((s) => s.traceId));
    expect(report.skipped).toEqual([]);
    const list = json<{ total: number }>(
      await t.app.inject({ method: "GET", url: "/api/v1/traces" }),
    );
    expect(list.total).toBe(demoTraces.length);
    for (const spec of demoTraces) {
      const { trace, branches } = await branchesOf(spec.traceId);
      expect(trace.branchCount, spec.traceId).toBe(spec.fork ? 2 : 1);
      expect(branches, spec.traceId).toHaveLength(spec.fork ? 2 : 1);
    }
    const comparisons = json<{ items: Comparison[] }>(
      await t.app.inject({
        method: "GET",
        url: `/api/v1/comparisons?traceId=${DEMO_TRACE_IDS.refundViolation}`,
      }),
    );
    expect(comparisons.items).toHaveLength(1);
  });

  it("produces identical ids on a fresh database", async () => {
    const fresh = await createTestApp();
    try {
      await fresh.seed();
      const out = new Map<string, string>();
      for (const spec of demoTraces.filter((s) => s.fork)) {
        const response = await fresh.app.inject({
          method: "GET",
          url: `/api/v1/traces/${spec.traceId}`,
        });
        out.set(
          spec.traceId,
          json<{ branches: Branch[] }>(response)
            .branches.map((b) => b.id)
            .join(","),
        );
      }
      expect(out).toEqual(firstForkIds);
    } finally {
      await fresh.close();
    }
  });
});
