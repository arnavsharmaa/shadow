import { recordExecution } from "@shadow/core";
import type { ReconstructedState, ShadowEvent, Trace, TraceSummary } from "@shadow/schemas";
import { syntheticAgentDefinition } from "@shadow/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chunk } from "../../src/services/context.js";
import { BASE_TIME, createTestApp, json, listAllEvents, type TestApp } from "../helpers.js";

const ITERATIONS = 1000;
const BATCH = 1000;
const BUDGET_MS = 60_000;

describe("large trace smoke test", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ env: { SHADOW_MAX_BODY_BYTES: String(64 * 1024 * 1024) } });
  });

  afterAll(async () => {
    await t.close();
  });

  it("ingests, paginates and reconstructs a ~5k event trace within budget", async () => {
    const traceId = "trc_load_synthetic";
    const recorded = await recordExecution({
      definition: syntheticAgentDefinition,
      input: { iterations: ITERATIONS },
      traceId,
      branchId: "br_load_root",
      traceName: "synthetic load",
      seed: "load",
      startAt: BASE_TIME,
    });
    expect(recorded.status).toBe("completed");
    expect(recorded.events.length).toBeGreaterThanOrEqual(5000);

    const started = performance.now();
    const created = await t.app.inject({
      method: "POST",
      url: "/api/v1/traces",
      payload: {
        id: traceId,
        project: "benchmarks",
        agent: syntheticAgentDefinition.slug,
        name: "synthetic load",
        startedAt: BASE_TIME,
      },
    });
    expect(created.statusCode).toBe(201);
    const trace = json<Trace>(created);

    const batches = chunk(recorded.events, BATCH);
    expect(batches.length).toBeGreaterThanOrEqual(5);
    for (const batch of batches) {
      const response = await t.app.inject({
        method: "POST",
        url: `/api/v1/traces/${traceId}/events`,
        payload: { events: batch },
      });
      expect(response.statusCode).toBe(201);
      expect(json<{ accepted: number }>(response).accepted).toBe(batch.length);
    }
    const ingestedAt = performance.now();

    const paged = await listAllEvents(t, traceId, { limit: 1000 });
    expect(paged).toHaveLength(recorded.events.length);
    expect(paged.map((e) => e.sequence)).toEqual(recorded.events.map((e) => e.sequence));
    expect(paged.map((e) => e.id)).toEqual(recorded.events.map((e) => e.id));
    const pagedAt = performance.now();

    const state = json<ReconstructedState>(
      await t.app.inject({ method: "GET", url: `/api/v1/branches/${trace.rootBranchId}/state` }),
    );
    let expectedTotal = 0;
    for (let i = 0; i < ITERATIONS; i++) expectedTotal += i * 2;
    expect(state.state.total).toBe(expectedTotal);
    expect(state.state.lastIteration).toBe(ITERATIONS - 1);
    expect(state.context.iterations).toBe(ITERATIONS);
    expect(state.fromSnapshotSequence).not.toBeNull();
    const midpoint = recorded.events.length >> 1;
    const mid = json<ReconstructedState>(
      await t.app.inject({
        method: "GET",
        url: `/api/v1/branches/${trace.rootBranchId}/state?sequence=${midpoint}`,
      }),
    );
    expect(mid.asOfSequence).toBeLessThanOrEqual(midpoint);
    expect(typeof mid.state.total).toBe("number");
    const stateAt = performance.now();

    const summary = json<{ trace: TraceSummary }>(
      await t.app.inject({ method: "GET", url: `/api/v1/traces/${traceId}` }),
    ).trace;
    expect(summary.status).toBe("completed");
    expect(summary.metrics.eventCount).toBe(recorded.events.length);
    expect(summary.metrics.toolCalls).toBe(ITERATIONS);
    expect(summary.metrics.modelCalls).toBe(ITERATIONS);
    const tools = json<{ items: ShadowEvent[]; nextCursor: string | null }>(
      await t.app.inject({
        method: "GET",
        url: `/api/v1/traces/${traceId}/events?eventType=tool.request&limit=1000`,
      }),
    );
    expect(tools.items).toHaveLength(ITERATIONS);
    expect(tools.nextCursor).toBeNull();

    const elapsed = performance.now() - started;
    console.info(
      `load: ${recorded.events.length} events; ingest ${Math.round(ingestedAt - started)}ms, paginate ${Math.round(pagedAt - ingestedAt)}ms, state ${Math.round(stateAt - pagedAt)}ms, total ${Math.round(elapsed)}ms`,
    );
    expect(elapsed).toBeLessThan(BUDGET_MS);
  }, 120_000);
});
