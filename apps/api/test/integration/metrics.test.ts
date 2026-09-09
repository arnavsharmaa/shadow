import { aggregateMetrics } from "@shadow/core";
import type { Branch, BranchMetrics, TraceSummary } from "@shadow/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recomputeBranchMetrics } from "../../src/services/events.js";
import {
  createTestApp,
  forkReplayCompare,
  json,
  listAllEvents,
  recordRefund,
  type TestApp,
} from "../helpers.js";

const TRACE_ID = "trc_metrics_incremental";

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await t.close();
});

async function branchMetrics(branchId: string): Promise<BranchMetrics> {
  const res = await t.app.inject({ method: "GET", url: `/api/v1/branches/${branchId}` });
  expect(res.statusCode).toBe(200);
  return json<Branch>(res).metrics;
}

describe("incremental branch metrics", () => {
  it("batched ingestion produces the same metrics as a full aggregation", async () => {
    const recorded = await recordRefund(TRACE_ID);
    const created = await t.app.inject({
      method: "POST",
      url: "/api/v1/traces",
      payload: { id: TRACE_ID, project: "support-agent", agent: "refund-agent", name: "metrics" },
    });
    expect(created.statusCode).toBe(201);
    // The trace uses a server-generated root branch id; events must target it.
    const rootBranchId = json<{ rootBranchId: string }>(created).rootBranchId;
    const events = recorded.events.map((e) => ({ ...e, branchId: rootBranchId }));
    const batches = [events.slice(0, 9), events.slice(9, 31), events.slice(31)];
    for (const batch of batches) {
      const res = await t.app.inject({
        method: "POST",
        url: `/api/v1/traces/${TRACE_ID}/events`,
        payload: { branchId: rootBranchId, events: batch },
      });
      expect(res.statusCode).toBe(201);
    }
    const stored = await listAllEvents(t, TRACE_ID, { branchId: rootBranchId });
    const full = aggregateMetrics(stored);
    expect(await branchMetrics(rootBranchId)).toEqual(full);

    const trace = json<{ trace: TraceSummary }>(
      await t.app.inject({ method: "GET", url: `/api/v1/traces/${TRACE_ID}` }),
    ).trace;
    expect(trace.metrics).toEqual(full);
    expect(full.durationMs).toBeGreaterThan(0);
    expect(full.toolCalls).toBe(6);

    // A full recomputation is a no-op on already-consistent data.
    const recomputed = await recomputeBranchMetrics(t.services, rootBranchId);
    expect(recomputed.metrics).toEqual(full);
  });

  it("forked branches inherit the prefix metrics and merge replayed events", async () => {
    const forkTrace = "trc_metrics_fork";
    const recorded = await recordRefund(forkTrace, { seed: "t2" });
    const created = await t.app.inject({
      method: "POST",
      url: "/api/v1/traces",
      payload: {
        id: forkTrace,
        project: "support-agent",
        agent: "refund-agent",
        name: "fork-metrics",
      },
    });
    const rootBranchId = json<{ rootBranchId: string }>(created).rootBranchId;
    await t.app.inject({
      method: "POST",
      url: `/api/v1/traces/${forkTrace}/events`,
      payload: {
        branchId: rootBranchId,
        events: recorded.events.map((e) => ({ ...e, branchId: rootBranchId })),
      },
    });
    const rootEvents = await listAllEvents(t, forkTrace, { branchId: rootBranchId });
    const forked = await forkReplayCompare(t, {
      traceId: forkTrace,
      rootBranchId,
      recorded,
      rootEvents,
    });

    const effective = await listAllEvents(t, forkTrace, { branchId: forked.branch.id });
    const full = aggregateMetrics(effective);
    expect(forked.branch.metrics).toEqual(full);
    expect(await branchMetrics(forked.branch.id)).toEqual(full);
    expect(full.eventCount).toBeGreaterThan(rootEvents.length - 10);
    // The counterfactual skips the paid refund tool, so it is cheaper.
    expect(full.totalEstimatedCost).toBeLessThan(aggregateMetrics(rootEvents).totalEstimatedCost);

    const recomputed = await recomputeBranchMetrics(t.services, forked.branch.id);
    expect(recomputed.metrics).toEqual(full);
  });
});
