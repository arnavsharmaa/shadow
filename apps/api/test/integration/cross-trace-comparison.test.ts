import type { Comparison, Trace, TraceExport } from "@shadow/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, ingestRefundScenario, json, type TestApp } from "../helpers.js";

let t: TestApp;
let a: { traceId: string; rootBranchId: string };
let b: { traceId: string; rootBranchId: string };

beforeAll(async () => {
  t = await createTestApp();
  a = await ingestRefundScenario(t, "trc_run_a");
  b = await ingestRefundScenario(t, "trc_run_b", {
    seed: "t2",
    startAt: "2026-09-02T10:00:00.000Z",
  });
});

afterAll(async () => {
  await t.close();
});

describe("cross-trace comparison", () => {
  let comparison: Comparison;

  it("compares branches of two different traces by aligning their steps", async () => {
    const response = await t.app.inject({
      method: "POST",
      url: "/api/v1/comparisons",
      payload: { baseBranchId: a.rootBranchId, targetBranchId: b.rootBranchId },
    });
    expect(response.statusCode).toBe(201);
    comparison = json<Comparison>(response);
    expect(comparison.traceId).toBe(a.traceId);
    expect(comparison.targetTraceId).toBe(b.traceId);
    const r = comparison.result;
    // Two identical runs: nothing shared by id, every step aligned as "same", no divergence.
    expect(r.steps.filter((s) => s.kind === "shared")).toHaveLength(0);
    expect(r.steps.length).toBeGreaterThan(10);
    expect(r.steps.every((s) => s.kind === "same")).toBe(true);
    expect(r.firstDivergence).toBeNull();
    expect(r.addedEvents).toHaveLength(0);
    expect(r.removedEvents).toHaveLength(0);
    expect(r.outcome.changed).toBe(false);
    expect(r.metrics.totalTokens.delta).toBe(0);

    const fetched = await t.app.inject({
      method: "GET",
      url: `/api/v1/comparisons/${comparison.id}`,
    });
    expect(json<Comparison>(fetched).targetTraceId).toBe(b.traceId);
  });

  it("is listed under both traces and excluded from either export", async () => {
    for (const traceId of [a.traceId, b.traceId]) {
      const page = json<{ items: Comparison[] }>(
        await t.app.inject({ method: "GET", url: `/api/v1/comparisons?traceId=${traceId}` }),
      );
      expect(page.items.map((c) => c.id)).toContain(comparison.id);
    }
    const bundle = json<TraceExport>(
      await t.app.inject({ method: "GET", url: `/api/v1/traces/${a.traceId}/export` }),
    );
    expect(bundle.comparisons.map((c) => c.id)).not.toContain(comparison.id);
  });

  it("same-trace comparisons keep targetTraceId null", async () => {
    const created = await t.app.inject({
      method: "POST",
      url: "/api/v1/traces",
      payload: { project: "p", agent: "a", name: "other" },
    });
    const other = json<Trace>(created);
    const same = await t.app.inject({
      method: "POST",
      url: "/api/v1/comparisons",
      payload: { baseBranchId: a.rootBranchId, targetBranchId: a.rootBranchId },
    });
    expect(same.statusCode).toBe(422);
    const empty = await t.app.inject({
      method: "POST",
      url: "/api/v1/comparisons",
      payload: { baseBranchId: a.rootBranchId, targetBranchId: other.rootBranchId },
    });
    expect(empty.statusCode).toBe(201);
    expect(json<Comparison>(empty).targetTraceId).toBe(other.id);
    expect(json<Comparison>(empty).result.removedEvents.length).toBeGreaterThan(0);
  });

  it("is removed when the target trace is deleted", async () => {
    const deleted = await t.app.inject({ method: "DELETE", url: `/api/v1/traces/${b.traceId}` });
    expect(deleted.statusCode).toBe(204);
    const gone = await t.app.inject({ method: "GET", url: `/api/v1/comparisons/${comparison.id}` });
    expect(gone.statusCode).toBe(404);
    const page = json<{ items: Comparison[] }>(
      await t.app.inject({ method: "GET", url: `/api/v1/comparisons?traceId=${a.traceId}` }),
    );
    expect(page.items.map((c) => c.id)).not.toContain(comparison.id);
  });
});
