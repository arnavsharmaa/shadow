import type {
  Branch,
  Comparison,
  ReconstructedState,
  Trace,
  TraceExport,
  TraceSummary,
} from "@shadow/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestApp,
  forkReplayCompare,
  ingestRefundScenario,
  json,
  listAllEvents,
  must,
  type ErrorEnvelope,
  type ForkedScenario,
  type RefundScenario,
  type TestApp,
} from "../helpers.js";

describe("export and import", () => {
  let t: TestApp;
  let scenario: RefundScenario;
  let forked: ForkedScenario;
  let bundle: TraceExport;
  let forkOwnCount: number;

  const getTrace = async (traceId: string) =>
    json<{ trace: TraceSummary; branches: Branch[] }>(
      await t.app.inject({ method: "GET", url: `/api/v1/traces/${traceId}` }),
    );

  async function importBundle(payload: unknown, idStrategy?: "keep" | "regenerate") {
    return t.app.inject({
      method: "POST",
      url: "/api/v1/traces/import",
      payload: { bundle: payload, idStrategy },
    });
  }

  beforeAll(async () => {
    t = await createTestApp({ env: { SHADOW_MAX_BODY_BYTES: "8388608" } });
    scenario = await ingestRefundScenario(t, "trc_test_transfer");
    forked = await forkReplayCompare(t, scenario);
    forkOwnCount = (
      await listAllEvents(t, scenario.traceId, { branchId: forked.branch.id, inherited: false })
    ).length;
  });

  afterAll(async () => {
    await t.close();
  });

  it("exports a self-contained bundle", async () => {
    const response = await t.app.inject({
      method: "GET",
      url: `/api/v1/traces/${scenario.traceId}/export`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-disposition"]).toBe(
      `attachment; filename="${scenario.traceId}.shadow.json"`,
    );
    bundle = json<TraceExport>(response);
    expect(bundle.format).toBe("shadow.trace");
    expect(bundle.schemaVersion).toBe("1.0");
    expect(bundle.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(bundle.project).toMatchObject({ slug: "support-agent", name: "Support Agent" });
    expect(bundle.agent).toMatchObject({ slug: "refund-agent", name: "Refund Agent" });
    expect(bundle.trace.id).toBe(scenario.traceId);
    expect(bundle.trace.rootBranchId).toBe(scenario.rootBranchId);
    expect(bundle.trace.status).toBe("failed");
    expect(bundle.branches.map((b) => b.id)).toEqual([scenario.rootBranchId, forked.branch.id]);
    expect(bundle.forks.map((f) => f.id)).toEqual([forked.fork.id]);
    expect(bundle.replays.map((r) => r.id)).toEqual([forked.replay.id]);
    expect(bundle.comparisons.map((c) => c.id)).toEqual([forked.comparison.id]);
    expect(bundle.events).toHaveLength(scenario.rootEvents.length + forkOwnCount);
    expect(bundle.events.every((e) => e.traceId === scenario.traceId)).toBe(true);
    expect(new Set(bundle.events.map((e) => e.id)).size).toBe(bundle.events.length);
    expect(
      (await t.app.inject({ method: "GET", url: "/api/v1/traces/trc_missing/export" })).statusCode,
    ).toBe(404);
  });

  it("refuses to import a bundle whose ids already exist when keeping ids", async () => {
    const response = await importBundle(bundle, "keep");
    expect(response.statusCode).toBe(409);
    const body = json<ErrorEnvelope>(response);
    expect(body.error.code).toBe("conflict");
    expect(body.error.details).toEqual({ traceId: scenario.traceId });
    expect(body.error.message).toContain("regenerate");
    const implicit = await importBundle(bundle);
    expect(implicit.statusCode).toBe(409);
  });

  it("imports a copy with regenerated ids that keeps branches, events and comparisons", async () => {
    const response = await importBundle(bundle, "regenerate");
    expect(response.statusCode).toBe(201);
    const copy = json<Trace>(response);
    expect(copy.id).toMatch(/^trc_/);
    expect(copy.id).not.toBe(scenario.traceId);
    expect(copy.rootBranchId).not.toBe(scenario.rootBranchId);
    expect(copy.status).toBe("failed");
    expect(copy.outcome?.kind).toBe("policy_violation");
    expect(copy.branchCount).toBe(2);
    expect(copy.metrics.totalEstimatedCost).toBe(bundle.trace.metrics.totalEstimatedCost);

    const { trace, branches } = await getTrace(copy.id);
    expect(trace.projectSlug).toBe("support-agent");
    expect(trace.agentSlug).toBe("refund-agent");
    expect(branches).toHaveLength(2);
    const root = must(branches.find((b) => b.id === copy.rootBranchId));
    const fork = must(branches.find((b) => b.id !== copy.rootBranchId));
    expect(root.name).toBe("main");
    expect(fork).toMatchObject({
      name: "fork-1",
      parentBranchId: root.id,
      forkSequence: forked.branch.forkSequence,
      status: "completed",
    });
    expect(fork.id).not.toBe(forked.branch.id);
    expect(fork.outcome?.kind).toBe("approval_pending");

    const rootEvents = await listAllEvents(t, copy.id, { branchId: root.id });
    expect(rootEvents).toHaveLength(scenario.rootEvents.length);
    expect(rootEvents.map((e) => e.sequence)).toEqual(scenario.rootEvents.map((e) => e.sequence));
    expect(rootEvents.map((e) => `${e.eventType} ${e.name}`)).toEqual(
      scenario.rootEvents.map((e) => `${e.eventType} ${e.name}`),
    );
    expect(rootEvents.every((e) => e.traceId === copy.id && e.branchId === root.id)).toBe(true);
    const originalIds = new Set(scenario.rootEvents.map((e) => e.id));
    expect(rootEvents.some((e) => originalIds.has(e.id))).toBe(false);
    const forkEvents = await listAllEvents(t, copy.id, { branchId: fork.id, inherited: false });
    expect(forkEvents).toHaveLength(forkOwnCount);
    expect(forkEvents[0]?.eventType).toBe("fork.created");
    expect(forkEvents[0]?.metadata).toMatchObject({ shadow: { forkId: fork.forkId } });

    const comparisons = json<{ items: Comparison[] }>(
      await t.app.inject({ method: "GET", url: `/api/v1/comparisons?traceId=${copy.id}` }),
    );
    expect(comparisons.items).toHaveLength(1);
    const copied = must(comparisons.items[0]);
    expect(copied.id).not.toBe(forked.comparison.id);
    expect(copied).toMatchObject({
      traceId: copy.id,
      baseBranchId: root.id,
      targetBranchId: fork.id,
    });
    const divergence = must(copied.result.firstDivergence);
    expect(divergence.reason).toBe(forked.comparison.result.firstDivergence?.reason);
    expect(divergence.base?.eventType).toBe("policy.evaluated");
    expect(divergence.fields).toEqual(forked.comparison.result.firstDivergence?.fields);
    expect(copied.result.outcome.changed).toBe(true);

    const state = json<ReconstructedState>(
      await t.app.inject({ method: "GET", url: `/api/v1/branches/${fork.id}/state` }),
    );
    expect(state.context.refundLimit).toBe(100);
    expect(
      json<{ items: Trace[] }>(
        await t.app.inject({ method: "GET", url: `/api/v1/traces/${copy.id}/replays` }),
      ).items,
    ).toHaveLength(1);
    expect((await getTrace(scenario.traceId)).trace.branchCount).toBe(2);
  });

  it("re-imports with identical ids once the original is gone", async () => {
    expect(
      (await t.app.inject({ method: "DELETE", url: `/api/v1/traces/${scenario.traceId}` }))
        .statusCode,
    ).toBe(204);
    expect(
      (await t.app.inject({ method: "GET", url: `/api/v1/comparisons/${forked.comparison.id}` }))
        .statusCode,
    ).toBe(404);

    const response = await importBundle(bundle, "keep");
    expect(response.statusCode).toBe(201);
    const restored = json<Trace>(response);
    expect(restored.id).toBe(scenario.traceId);
    expect(restored.rootBranchId).toBe(scenario.rootBranchId);
    expect(restored.branchCount).toBe(2);

    const { branches } = await getTrace(scenario.traceId);
    expect(branches.map((b) => b.id)).toEqual([scenario.rootBranchId, forked.branch.id]);
    const rootEvents = await listAllEvents(t, scenario.traceId, {
      branchId: scenario.rootBranchId,
    });
    expect(rootEvents.map((e) => e.id)).toEqual(scenario.rootEvents.map((e) => e.id));
    expect(
      await listAllEvents(t, scenario.traceId, { branchId: forked.branch.id, inherited: false }),
    ).toHaveLength(forkOwnCount);
    const comparison = await t.app.inject({
      method: "GET",
      url: `/api/v1/comparisons/${forked.comparison.id}`,
    });
    expect(comparison.statusCode).toBe(200);
    expect(json<Comparison>(comparison).result.firstDivergence).toEqual(
      forked.comparison.result.firstDivergence,
    );
    const exported = json<TraceExport>(
      await t.app.inject({ method: "GET", url: `/api/v1/traces/${scenario.traceId}/export` }),
    );
    expect(exported.events.map((e) => e.id).sort()).toEqual(bundle.events.map((e) => e.id).sort());
    expect(exported.forks).toEqual(bundle.forks);
  });

  it("rejects invalid bundles with issue details", async () => {
    const missingRoot = await importBundle(
      { ...bundle, trace: { ...bundle.trace, id: "trc_broken" }, branches: [] },
      "regenerate",
    );
    expect(missingRoot.statusCode).toBe(400);
    const body = json<ErrorEnvelope>(missingRoot);
    expect(body.error.code).toBe("bad_request");
    expect(body.error.message).toBe("bundle failed validation");
    const issues = body.error.details as string[];
    expect(issues.some((i) => /root branch .* missing/.test(i))).toBe(true);
    expect(missingRoot.headers["x-request-id"]).toBe(body.error.requestId);

    const wrongFormat = await importBundle({ format: "nope", trace: {} }, "regenerate");
    expect(wrongFormat.statusCode).toBe(400);
    const formatBody = json<ErrorEnvelope>(wrongFormat);
    expect(formatBody.error.code).toBe("validation_error");
    expect((formatBody.error.details as unknown[]).length).toBeGreaterThan(0);

    const foreignEvent = await importBundle(
      {
        ...bundle,
        trace: { ...bundle.trace, id: "trc_broken2" },
        branches: bundle.branches.map((b) => ({ ...b, traceId: "trc_broken2" })),
      },
      "regenerate",
    );
    expect(foreignEvent.statusCode).toBe(400);
    expect(
      (json<ErrorEnvelope>(foreignEvent).error.details as string[]).some((i) =>
        i.includes("belongs to another trace"),
      ),
    ).toBe(true);

    const badStrategy = await t.app.inject({
      method: "POST",
      url: "/api/v1/traces/import",
      payload: { bundle, idStrategy: "clone" },
    });
    expect(badStrategy.statusCode).toBe(400);
    expect(
      (await t.app.inject({ method: "GET", url: "/api/v1/traces/trc_broken" })).statusCode,
    ).toBe(404);
  });
});
