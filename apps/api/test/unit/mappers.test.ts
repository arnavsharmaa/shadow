import type { ShadowEvent } from "@shadow/schemas";
import { emptyBranchMetrics } from "@shadow/schemas";
import { describe, expect, it } from "vitest";
import {
  iso,
  isoOrNull,
  toBranch,
  toEvent,
  toEventRow,
  toMetrics,
  toTrace,
  type BranchRow,
  type EventRow,
  type TraceRow,
} from "../../src/services/mappers.js";

const TS = "2026-09-01T09:00:00.000Z";

function sampleEvent(overrides: Partial<ShadowEvent> & Record<string, unknown> = {}): ShadowEvent {
  return {
    id: "evt_1",
    schemaVersion: "1.0",
    traceId: "trc_1",
    branchId: "br_1",
    parentEventId: null,
    spanId: "spn_1",
    parentSpanId: null,
    sequence: 3,
    timestamp: TS,
    durationMs: 12.5,
    eventType: "tool.request",
    source: "sdk",
    severity: "info",
    name: "read_customer",
    input: { tool: "read_customer", arguments: { customerId: "cus_1" } },
    output: { result: { ok: true } },
    metadata: { shadow: { origin: "recorded" } },
    tags: ["a"],
    tokenUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    estimatedCost: { amount: 0.01, currency: "USD" },
    stateVersion: 4,
    correlationId: "corr-1",
    ...overrides,
  };
}

describe("iso", () => {
  it("normalises Postgres text timestamps to ISO", () => {
    expect(iso("2026-09-01 09:00:00+00")).toBe(TS);
    expect(iso("2026-09-01 11:00:00.5+02")).toBe("2026-09-01T09:00:00.500Z");
    expect(iso(new Date(TS))).toBe(TS);
    expect(iso(TS)).toBe(TS);
  });

  it("falls back to the epoch for missing values and echoes unparseable ones", () => {
    expect(iso(null)).toBe("1970-01-01T00:00:00.000Z");
    expect(iso(undefined)).toBe("1970-01-01T00:00:00.000Z");
    expect(iso("not a date")).toBe("not a date");
    expect(isoOrNull(null)).toBeNull();
    expect(isoOrNull(undefined)).toBeNull();
    expect(isoOrNull("2026-09-01 09:00:00+00")).toBe(TS);
  });
});

describe("event mapping", () => {
  it("round-trips a fully populated event", () => {
    const event = sampleEvent();
    const row = toEventRow(event);
    expect(row.extra).toBeNull();
    expect(toEvent(row as EventRow)).toEqual(event);
  });

  it("preserves unknown top-level fields through `extra`", () => {
    const event = sampleEvent({ vendor: { plugin: "langgraph", node: "n1" }, custom: 7 });
    const row = toEventRow(event);
    expect(row.extra).toEqual({ vendor: { plugin: "langgraph", node: "n1" }, custom: 7 });
    expect("vendor" in row).toBe(false);
    const back = toEvent(row as EventRow);
    expect(back).toEqual(event);
    expect(back.vendor).toEqual({ plugin: "langgraph", node: "n1" });
  });

  it("does not let extra fields shadow known columns", () => {
    const row: EventRow = {
      ...(toEventRow(sampleEvent()) as EventRow),
      extra: { id: "evt_evil", sequence: 999, custom: "kept" },
    };
    const event = toEvent(row);
    expect(event.id).toBe("evt_1");
    expect(event.sequence).toBe(3);
    expect(event.custom).toBe("kept");
  });

  it("maps undefined input/output to NULL and omits them on the way back", () => {
    const event = sampleEvent({
      input: undefined,
      output: undefined,
      tokenUsage: null,
      estimatedCost: null,
    });
    const row = toEventRow(event);
    expect(row.input).toBeNull();
    expect(row.output).toBeNull();
    expect(row.tokenUsage).toBeNull();
    const back = toEvent(row as EventRow);
    expect("input" in back).toBe(false);
    expect("output" in back).toBe(false);
    expect(back.tokenUsage).toBeNull();
    expect(back.estimatedCost).toBeNull();
  });

  it("keeps falsy JSON payloads", () => {
    const event = sampleEvent({ input: 0, output: false });
    const back = toEvent(toEventRow(event) as EventRow);
    expect(back.input).toBe(0);
    expect(back.output).toBe(false);
  });

  it("normalises driver timestamps and tolerates malformed jsonb columns", () => {
    const row = toEventRow(sampleEvent()) as EventRow;
    const back = toEvent({
      ...row,
      timestamp: "2026-09-01 09:00:00+00",
      metadata: "junk",
      tags: "junk",
    });
    expect(back.timestamp).toBe(TS);
    expect(back.metadata).toEqual({});
    expect(back.tags).toEqual([]);
  });
});

describe("trace and branch mapping", () => {
  it("fills metrics defaults and normalises timestamps", () => {
    expect(toMetrics(undefined)).toEqual(emptyBranchMetrics());
    expect(toMetrics({ toolCalls: 2 })).toEqual({ ...emptyBranchMetrics(), toolCalls: 2 });
    const row: TraceRow = {
      id: "trc_1",
      projectId: "prj_1",
      agentId: "agt_1",
      rootBranchId: "br_1",
      name: "t",
      status: "running",
      schemaVersion: "1.0",
      startedAt: "2026-09-01 09:00:00+00",
      completedAt: null,
      durationMs: null,
      outcome: null,
      tags: ["x", 5],
      metadata: {},
      metrics: { modelCalls: 1 },
      branchCount: 1,
      searchText: "",
      createdAt: "2026-09-01 09:00:00+00",
      updatedAt: "2026-09-01 09:00:01+00",
    };
    const trace = toTrace(row);
    expect(trace.startedAt).toBe(TS);
    expect(trace.completedAt).toBeNull();
    expect(trace.tags).toEqual(["x"]);
    expect(trace.metrics.modelCalls).toBe(1);
    expect(trace.metrics.toolCalls).toBe(0);
    expect(trace.updatedAt).toBe("2026-09-01T09:00:01.000Z");
    expect("searchText" in trace).toBe(false);
  });

  it("maps branch rows", () => {
    const row: BranchRow = {
      id: "br_2",
      traceId: "trc_1",
      name: "fork-1",
      parentBranchId: "br_1",
      forkId: "frk_1",
      forkEventId: "evt_9",
      forkSequence: 8,
      depth: 1,
      status: "pending",
      outcome: { kind: "refunded", label: "Refund issued" },
      metrics: {},
      metadata: { note: 1 },
      createdAt: TS,
      updatedAt: TS,
    };
    const branch = toBranch(row);
    expect(branch).toMatchObject({
      id: "br_2",
      parentBranchId: "br_1",
      forkSequence: 8,
      depth: 1,
      status: "pending",
    });
    expect(branch.outcome?.kind).toBe("refunded");
    expect(branch.metrics).toEqual(emptyBranchMetrics());
    expect(branch.metadata).toEqual({ note: 1 });
  });
});
