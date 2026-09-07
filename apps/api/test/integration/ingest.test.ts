import type { Branch, ReconstructedState, ShadowEvent, Trace, TraceSummary } from "@shadow/schemas";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stateSnapshots } from "../../src/db/schema.js";
import {
  createTestApp,
  ingestEvent,
  json,
  listAllEvents,
  type ErrorEnvelope,
  type TestApp,
} from "../helpers.js";

const T0 = "2026-09-01T09:00:00.000Z";
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

interface IngestResponse {
  accepted: number;
  branch: Branch;
  eventIds: string[];
}

describe("event ingestion", () => {
  let t: TestApp;
  let counter = 0;

  async function newTrace(): Promise<Trace> {
    counter++;
    const response = await t.app.inject({
      method: "POST",
      url: "/api/v1/traces",
      payload: {
        id: `trc_ingest_${counter}`,
        project: "support-agent",
        agent: "refund-agent",
        name: `ingest ${counter}`,
        startedAt: T0,
      },
    });
    if (response.statusCode !== 201) throw new Error(response.body);
    return json<Trace>(response);
  }

  async function ingest(traceId: string, events: unknown[], branchId?: string) {
    return t.app.inject({
      method: "POST",
      url: `/api/v1/traces/${traceId}/events`,
      payload: { events, branchId },
    });
  }

  async function getTrace(traceId: string) {
    return json<{ trace: TraceSummary; branches: Branch[] }>(
      await t.app.inject({ method: "GET", url: `/api/v1/traces/${traceId}` }),
    );
  }

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  it("assigns ids, sequences and timestamps when omitted", async () => {
    const trace = await newTrace();
    const before = Date.now();
    const response = await ingest(trace.id, [
      ingestEvent("trace.started", "start"),
      ingestEvent("agent.note", "note", { input: { a: 1 } }),
    ]);
    expect(response.statusCode).toBe(201);
    const body = json<IngestResponse>(response);
    expect(body.accepted).toBe(2);
    expect(body.eventIds).toHaveLength(2);
    for (const id of body.eventIds) expect(id).toMatch(/^evt_[a-f0-9]{32}$/);
    expect(body.branch.id).toBe(trace.rootBranchId);
    expect(body.branch.metrics.eventCount).toBe(2);

    const events = await listAllEvents(t, trace.id);
    expect(events.map((e) => e.sequence)).toEqual([0, 1]);
    expect(events.map((e) => e.id)).toEqual(body.eventIds);
    for (const event of events) {
      expect(event.timestamp).toMatch(ISO);
      expect(Date.parse(event.timestamp)).toBeGreaterThanOrEqual(before - 1000);
      expect(event.traceId).toBe(trace.id);
      expect(event.branchId).toBe(trace.rootBranchId);
      expect(event.schemaVersion).toBe("1.0");
      expect(event.source).toBe("sdk");
      expect(event.severity).toBe("info");
      expect(event.metadata).toEqual({});
      expect(event.tags).toEqual([]);
    }
    expect(events[1]?.input).toEqual({ a: 1 });
    expect("output" in (events[1] ?? {})).toBe(false);
  });

  it("respects explicit ids and sequences and continues after them", async () => {
    const trace = await newTrace();
    const first = await ingest(trace.id, [
      ingestEvent("trace.started", "start", { id: "evt_custom_1", sequence: 5, timestamp: T0 }),
      ingestEvent("agent.note", "note"),
    ]);
    expect(first.statusCode).toBe(201);
    expect(json<IngestResponse>(first).eventIds[0]).toBe("evt_custom_1");
    const second = await ingest(trace.id, [ingestEvent("agent.note", "later")]);
    expect(second.statusCode).toBe(201);
    const events = await listAllEvents(t, trace.id);
    expect(events.map((e) => e.sequence)).toEqual([5, 6, 7]);
    expect(events[0]?.timestamp).toBe(T0);
  });

  it("rejects duplicate sequences within a batch", async () => {
    const trace = await newTrace();
    const response = await ingest(trace.id, [
      ingestEvent("agent.note", "a", { sequence: 2 }),
      ingestEvent("agent.note", "b", { sequence: 2 }),
    ]);
    expect(response.statusCode).toBe(409);
    const body = json<ErrorEnvelope>(response);
    expect(body.error.code).toBe("conflict");
    expect(body.error.message).toContain("duplicate sequence 2 in batch");
    expect(body.error.details).toEqual({ sequence: 2 });
    expect(await listAllEvents(t, trace.id)).toHaveLength(0);
  });

  it("rejects sequences and ids that already exist and rolls back the batch", async () => {
    const trace = await newTrace();
    expect(
      (await ingest(trace.id, [ingestEvent("agent.note", "a", { id: "evt_dup" })])).statusCode,
    ).toBe(201);
    const bySequence = await ingest(trace.id, [
      ingestEvent("agent.note", "b", { sequence: 0 }),
      ingestEvent("agent.note", "c", { sequence: 50 }),
    ]);
    expect(bySequence.statusCode).toBe(409);
    expect(json<ErrorEnvelope>(bySequence).error.message).toContain(
      "already exists on this branch",
    );
    const byId = await ingest(trace.id, [ingestEvent("agent.note", "d", { id: "evt_dup" })]);
    expect(byId.statusCode).toBe(409);
    const events = await listAllEvents(t, trace.id);
    expect(events.map((e) => e.sequence)).toEqual([0]);
  });

  it("validates event shapes", async () => {
    const trace = await newTrace();
    const badType = await ingest(trace.id, [ingestEvent("BadType", "x")]);
    expect(badType.statusCode).toBe(400);
    expect(json<ErrorEnvelope>(badType).error.code).toBe("validation_error");
    expect((await ingest(trace.id, [ingestEvent("agent.note", "")])).statusCode).toBe(400);
    expect(
      (await ingest(trace.id, [ingestEvent("agent.note", "x", { severity: "loud" })])).statusCode,
    ).toBe(400);
    expect(
      (await ingest(trace.id, [ingestEvent("agent.note", "x", { timestamp: "not a date" })]))
        .statusCode,
    ).toBe(400);
    expect((await ingest(trace.id, [])).statusCode).toBe(400);
    const tooMany = await ingest(
      trace.id,
      Array.from({ length: 5001 }, (_, i) => ingestEvent("agent.note", `n${i}`)),
    );
    expect(tooMany.statusCode).toBe(400);
    expect(await listAllEvents(t, trace.id)).toHaveLength(0);
  });

  it("accepts unknown event types and preserves extra top-level fields", async () => {
    const trace = await newTrace();
    const response = await ingest(trace.id, [
      {
        eventType: "langgraph.node_entered",
        name: "n1",
        vendor: { node: "n1", attempt: 2 },
        correlationId: "corr",
      },
    ]);
    expect(response.statusCode).toBe(201);
    const [event] = await listAllEvents(t, trace.id);
    expect(event?.eventType).toBe("langgraph.node_entered");
    expect(event?.vendor).toEqual({ node: "n1", attempt: 2 });
    expect(event?.correlationId).toBe("corr");
    const single = await t.app.inject({
      method: "GET",
      url: `/api/v1/traces/${trace.id}/events/${event?.id ?? ""}`,
    });
    expect(single.statusCode).toBe(200);
    expect(json<ShadowEvent>(single).vendor).toEqual({ node: "n1", attempt: 2 });
  });

  it("returns 404 for unknown traces and branches, 400 for foreign branches", async () => {
    const missing = await ingest("trc_nope", [ingestEvent("agent.note", "x")]);
    expect(missing.statusCode).toBe(404);
    expect(json<ErrorEnvelope>(missing).error.code).toBe("not_found");
    const a = await newTrace();
    const b = await newTrace();
    const unknownBranch = await ingest(a.id, [ingestEvent("agent.note", "x")], "br_missing");
    expect(unknownBranch.statusCode).toBe(404);
    const foreign = await ingest(a.id, [ingestEvent("agent.note", "x")], b.rootBranchId);
    expect(foreign.statusCode).toBe(400);
    expect(json<ErrorEnvelope>(foreign).error.code).toBe("bad_request");
  });

  it("redacts sensitive keys and values in input, output and metadata", async () => {
    const trace = await newTrace();
    const response = await ingest(trace.id, [
      ingestEvent("tool.request", "call", {
        input: {
          password: "hunter2",
          nested: { api_key: "k-123", list: [{ Authorization: "Bearer x" }] },
          safe: "keep",
        },
        output: {
          authorization: "Bearer abc.def",
          token: "t",
          ok: true,
          secretLooking: "sk-abcdefghijklmnopqrstuvwxyz1234",
        },
        metadata: { apiKey: "zzz", ticket: "TCK-1" },
      }),
    ]);
    expect(response.statusCode).toBe(201);
    const [event] = await listAllEvents(t, trace.id);
    expect(event?.input).toEqual({
      password: "[REDACTED]",
      nested: { api_key: "[REDACTED]", list: [{ Authorization: "[REDACTED]" }] },
      safe: "keep",
    });
    expect(event?.output).toEqual({
      authorization: "[REDACTED]",
      token: "[REDACTED]",
      ok: true,
      secretLooking: "[REDACTED]",
    });
    expect(event?.metadata).toEqual({ apiKey: "[REDACTED]", ticket: "TCK-1" });
    expect(JSON.stringify(event)).not.toContain("hunter2");
  });

  it("completes the trace and root branch on trace.completed", async () => {
    const trace = await newTrace();
    const response = await ingest(trace.id, [
      ingestEvent("trace.started", "start", { timestamp: T0 }),
      ingestEvent("agent.note", "note", { timestamp: "2026-09-01T09:00:01.000Z" }),
      ingestEvent("trace.completed", "trace.completed", {
        timestamp: "2026-09-01T09:00:05.000Z",
        output: { outcome: { kind: "refunded", label: "Refund issued", summary: "done" } },
      }),
    ]);
    expect(response.statusCode).toBe(201);
    expect(json<IngestResponse>(response).branch.status).toBe("completed");
    const { trace: summary, branches } = await getTrace(trace.id);
    expect(summary.status).toBe("completed");
    expect(summary.outcome).toEqual({ kind: "refunded", label: "Refund issued", summary: "done" });
    expect(summary.startedAt).toBe(T0);
    expect(summary.completedAt).toBe("2026-09-01T09:00:05.000Z");
    expect(summary.durationMs).toBe(5000);
    expect(summary.metrics.durationMs).toBe(5000);
    expect(branches[0]?.status).toBe("completed");
    expect(branches[0]?.outcome?.kind).toBe("refunded");
  });

  it("marks the trace failed on trace.failed and derives an error outcome", async () => {
    const trace = await newTrace();
    await ingest(trace.id, [
      ingestEvent("trace.started", "start", { timestamp: T0 }),
      ingestEvent("trace.failed", "trace.failed", {
        timestamp: "2026-09-01T09:00:02.500Z",
        severity: "error",
        output: { error: { message: "boom" } },
      }),
    ]);
    const { trace: summary, branches } = await getTrace(trace.id);
    expect(summary.status).toBe("failed");
    expect(summary.outcome).toEqual({ kind: "error", label: "boom" });
    expect(summary.durationMs).toBe(2500);
    expect(branches[0]?.status).toBe("failed");
  });

  it("recomputes metrics from the ingested events", async () => {
    const trace = await newTrace();
    const first = await ingest(trace.id, [
      ingestEvent("model.request", "plan", { timestamp: T0 }),
      ingestEvent("model.response", "plan", {
        timestamp: "2026-09-01T09:00:00.100Z",
        tokenUsage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        estimatedCost: { amount: 0.5, currency: "USD", provider: "shadow-sim", model: "sim" },
      }),
      ingestEvent("tool.request", "read_customer", { timestamp: "2026-09-01T09:00:00.200Z" }),
      ingestEvent("tool.response", "read_customer", {
        timestamp: "2026-09-01T09:00:00.300Z",
        estimatedCost: { amount: 0.25, currency: "USD" },
      }),
      ingestEvent("policy.evaluated", "refund.autonomous_limit", {
        timestamp: "2026-09-01T09:00:00.400Z",
      }),
      ingestEvent("tool.error", "flaky", {
        timestamp: "2026-09-01T09:00:01.000Z",
        severity: "error",
      }),
    ]);
    expect(first.statusCode).toBe(201);
    const { trace: summary } = await getTrace(trace.id);
    expect(summary.metrics).toMatchObject({
      eventCount: 6,
      modelCalls: 1,
      toolCalls: 1,
      toolErrors: 1,
      policyEvaluations: 1,
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      estimatedModelCost: 0.5,
      estimatedToolCost: 0.25,
      totalEstimatedCost: 0.75,
      durationMs: 1000,
      currency: "USD",
    });
    expect(json<IngestResponse>(first).branch.metrics).toEqual(summary.metrics);

    const second = await ingest(trace.id, [
      ingestEvent("tool.request", "send_email", { timestamp: "2026-09-01T09:00:02.000Z" }),
      ingestEvent("model.request", "compose", {
        timestamp: "2026-09-01T09:00:03.000Z",
        tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      }),
    ]);
    expect(second.statusCode).toBe(201);
    const after = (await getTrace(trace.id)).trace.metrics;
    expect(after.eventCount).toBe(8);
    expect(after.toolCalls).toBe(2);
    expect(after.modelCalls).toBe(2);
    expect(after.totalTokens).toBe(32);
    expect(after.totalEstimatedCost).toBe(0.75);
    expect(after.durationMs).toBe(3000);
  });

  it("stores state.snapshot events as snapshots and reconstructs state from them", async () => {
    const trace = await newTrace();
    const response = await ingest(trace.id, [
      ingestEvent("state.snapshot", "snapshot", {
        stateVersion: 1,
        output: { state: { a: 1 }, context: { k: "v" } },
      }),
      ingestEvent("state.patch", "patch", {
        stateVersion: 2,
        output: { ops: [{ op: "add", path: "/b", value: 2 }] },
      }),
      ingestEvent("context.added", "context", {
        stateVersion: 3,
        output: { key: "k2", value: "v2" },
      }),
      ingestEvent("agent.note", "note"),
    ]);
    expect(response.statusCode).toBe(201);
    const ids = json<IngestResponse>(response).eventIds;

    const rows = await t.handle.db
      .select()
      .from(stateSnapshots)
      .where(eq(stateSnapshots.branchId, trace.rootBranchId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventId: ids[0],
      sequence: 0,
      stateVersion: 1,
      state: { a: 1 },
      context: { k: "v" },
    });

    const latest = json<ReconstructedState & { branchId: string }>(
      await t.app.inject({ method: "GET", url: `/api/v1/branches/${trace.rootBranchId}/state` }),
    );
    expect(latest).toMatchObject({
      branchId: trace.rootBranchId,
      state: { a: 1, b: 2 },
      context: { k: "v", k2: "v2" },
      stateVersion: 3,
      fromSnapshotSequence: 0,
      asOfSequence: 2,
      appliedEvents: 2,
    });

    const atZero = json<ReconstructedState>(
      await t.app.inject({
        method: "GET",
        url: `/api/v1/branches/${trace.rootBranchId}/state?sequence=0`,
      }),
    );
    expect(atZero).toMatchObject({
      state: { a: 1 },
      context: { k: "v" },
      fromSnapshotSequence: 0,
      appliedEvents: 0,
      asOfSequence: 0,
    });

    const atOne = json<ReconstructedState>(
      await t.app.inject({
        method: "GET",
        url: `/api/v1/branches/${trace.rootBranchId}/state?sequence=1`,
      }),
    );
    expect(atOne).toMatchObject({
      state: { a: 1, b: 2 },
      context: { k: "v" },
      fromSnapshotSequence: 0,
      appliedEvents: 1,
    });

    const byEvent = json<ReconstructedState>(
      await t.app.inject({
        method: "GET",
        url: `/api/v1/branches/${trace.rootBranchId}/state?eventId=${ids[3] ?? ""}`,
      }),
    );
    expect(byEvent.state).toEqual({ a: 1, b: 2 });

    const beforeAnything = json<ReconstructedState>(
      await t.app.inject({
        method: "GET",
        url: `/api/v1/branches/${trace.rootBranchId}/state?sequence=-1`,
      }),
    );
    expect(beforeAnything).toMatchObject({
      state: {},
      context: {},
      fromSnapshotSequence: null,
      asOfSequence: -1,
    });

    const unknownEvent = await t.app.inject({
      method: "GET",
      url: `/api/v1/branches/${trace.rootBranchId}/state?eventId=evt_missing`,
    });
    expect(unknownEvent.statusCode).toBe(404);
    const unknownBranch = await t.app.inject({
      method: "GET",
      url: "/api/v1/branches/br_missing/state",
    });
    expect(unknownBranch.statusCode).toBe(404);
  });

  it("uses the latest snapshot at or before the requested sequence", async () => {
    const trace = await newTrace();
    await ingest(trace.id, [
      ingestEvent("state.snapshot", "s0", { output: { state: { n: 0 }, context: {} } }),
      ingestEvent("state.patch", "p1", {
        output: { ops: [{ op: "replace", path: "/n", value: 1 }] },
      }),
      ingestEvent("state.patch", "p2", {
        output: { ops: [{ op: "replace", path: "/n", value: 2 }] },
      }),
      ingestEvent("state.snapshot", "s3", { output: { state: { n: 3 }, context: { late: true } } }),
      ingestEvent("state.patch", "p4", {
        output: { ops: [{ op: "replace", path: "/n", value: 4 }] },
      }),
    ]);
    const state = async (sequence?: number) =>
      json<ReconstructedState>(
        await t.app.inject({
          method: "GET",
          url: `/api/v1/branches/${trace.rootBranchId}/state${sequence === undefined ? "" : `?sequence=${sequence}`}`,
        }),
      );
    expect(await state(2)).toMatchObject({
      state: { n: 2 },
      fromSnapshotSequence: 0,
      appliedEvents: 2,
    });
    expect(await state(3)).toMatchObject({
      state: { n: 3 },
      context: { late: true },
      fromSnapshotSequence: 3,
      appliedEvents: 0,
    });
    expect(await state()).toMatchObject({
      state: { n: 4 },
      fromSnapshotSequence: 3,
      appliedEvents: 1,
      asOfSequence: 4,
    });
  });
});

describe("body size limit", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ env: { SHADOW_MAX_BODY_BYTES: "65536" } });
  });

  afterAll(async () => {
    await t.close();
  });

  it("returns 413 payload_too_large above SHADOW_MAX_BODY_BYTES", async () => {
    const trace = json<Trace>(
      await t.app.inject({
        method: "POST",
        url: "/api/v1/traces",
        payload: { project: "p", agent: "a", name: "big" },
      }),
    );
    const tooLarge = await t.app.inject({
      method: "POST",
      url: `/api/v1/traces/${trace.id}/events`,
      payload: {
        events: [ingestEvent("agent.note", "big", { input: { blob: "x".repeat(100_000) } })],
      },
    });
    expect(tooLarge.statusCode).toBe(413);
    const body = json<ErrorEnvelope>(tooLarge);
    expect(body.error.code).toBe("payload_too_large");
    expect(body.error.message).toContain("65536");
    expect(tooLarge.headers["x-request-id"]).toBe(body.error.requestId);

    const small = await t.app.inject({
      method: "POST",
      url: `/api/v1/traces/${trace.id}/events`,
      payload: {
        events: [ingestEvent("agent.note", "small", { input: { blob: "x".repeat(1000) } })],
      },
    });
    expect(small.statusCode).toBe(201);
    expect(await listAllEvents(t, trace.id)).toHaveLength(1);
  });
});
