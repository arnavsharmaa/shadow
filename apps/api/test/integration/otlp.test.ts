import type { Branch, ShadowEvent, TraceSummary } from "@shadow/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, json, listAllEvents, type TestApp } from "../helpers.js";
import { refundPayload } from "../fixtures/otlp.js";

let t: TestApp;
const TRACE_ID = "trc_otel_4bf92f3577b34da6a3ce929d0e0e4736";

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await t.close();
});

describe("POST /api/v1/otlp/v1/traces", () => {
  it("imports an OTLP JSON export as a Shadow trace", async () => {
    const response = await t.app.inject({
      method: "POST",
      url: "/api/v1/otlp/v1/traces",
      payload: refundPayload(),
    });
    expect(response.statusCode).toBe(200);
    expect(json(response)).toEqual({
      partialSuccess: {},
      shadow: {
        traces: [
          {
            traceId: TRACE_ID,
            otelTraceId: "4bf92f3577b34da6a3ce929d0e0e4736",
            created: true,
            accepted: 14,
            skipped: 0,
          },
        ],
      },
    });

    const detail = json<{ trace: TraceSummary; branches: Branch[] }>(
      await t.app.inject({ method: "GET", url: `/api/v1/traces/${TRACE_ID}` }),
    );
    expect(detail.trace).toMatchObject({
      projectSlug: "support",
      agentSlug: "refund-agent",
      name: "invoke_agent refund-agent",
      status: "failed",
      startedAt: "2026-09-01T09:12:04.000Z",
      completedAt: "2026-09-01T09:12:08.000Z",
      durationMs: 4000,
      tags: ["otel"],
    });
    expect(detail.trace.outcome).toEqual({ kind: "error", label: "Failed: refund exceeded limit" });
    expect(detail.trace.metrics).toMatchObject({
      eventCount: 14,
      modelCalls: 1,
      toolCalls: 2,
      toolErrors: 1,
      policyEvaluations: 1,
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
    });
    const events = await listAllEvents(t, TRACE_ID, { branchId: detail.trace.rootBranchId });
    expect(events.map((e: ShadowEvent) => e.sequence)).toEqual([...events.keys()]);
    expect(events.every((e: ShadowEvent) => e.source === "otlp")).toBe(true);
    const tree = json<{ nodes: { id: string; depth: number }[] }>(
      await t.app.inject({ method: "GET", url: `/api/v1/traces/${TRACE_ID}/tree` }),
    );
    const depthOf = (id: string) => tree.nodes.find((n) => n.id === id)?.depth;
    expect(depthOf("evt_otel_a1b2c3d4e5f60001_start")).toBe(
      (depthOf("evt_otel_00f067aa0ba902b7_start") ?? 0) + 1,
    );
    expect(depthOf("evt_otel_a1b2c3d4e5f60004_start")).toBe(
      (depthOf("evt_otel_a1b2c3d4e5f60002_start") ?? 0) + 1,
    );

    // Context from the reserved span event is visible in reconstructed state.
    const state = json<{ context: Record<string, unknown> }>(
      await t.app.inject({
        method: "GET",
        url: `/api/v1/branches/${detail.trace.rootBranchId}/state`,
      }),
    );
    expect(state.context).toEqual({ refundLimit: 100 });
  });

  it("ignores re-sent spans and appends late spans without a second lifecycle", async () => {
    const again = await t.app.inject({
      method: "POST",
      url: "/api/v1/otlp/v1/traces",
      payload: refundPayload(),
    });
    expect(
      json<{ shadow: { traces: { created: boolean; accepted: number; skipped: number }[] } }>(again)
        .shadow.traces[0],
    ).toEqual(expect.objectContaining({ created: false, accepted: 0, skipped: 12 }));

    const late = refundPayload();
    const scope = late.resourceSpans?.[0]?.scopeSpans?.[0];
    if (!scope) throw new Error("fixture");
    scope.spans = [
      {
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        spanId: "a1b2c3d4e5f60009",
        parentSpanId: "00f067aa0ba902b7",
        name: "execute_tool audit_log",
        kind: 1,
        startTimeUnixNano: String(1_788_253_927_000_000_000n),
        endTimeUnixNano: String(1_788_253_927_100_000_000n),
        attributes: [
          { key: "gen_ai.operation.name", value: { stringValue: "execute_tool" } },
          { key: "gen_ai.tool.name", value: { stringValue: "audit_log" } },
        ],
      },
    ];
    const appended = await t.app.inject({
      method: "POST",
      url: "/api/v1/otlp/v1/traces",
      payload: late,
    });
    expect(appended.statusCode).toBe(200);
    const detail = json<{ trace: TraceSummary }>(
      await t.app.inject({ method: "GET", url: `/api/v1/traces/${TRACE_ID}` }),
    );
    const events = await listAllEvents(t, TRACE_ID, { branchId: detail.trace.rootBranchId });
    expect(events).toHaveLength(16);
    expect(events.filter((e: ShadowEvent) => e.eventType.startsWith("trace."))).toHaveLength(2);
    const lateEvents = events.filter((e: ShadowEvent) => e.name === "audit_log");
    expect(lateEvents.map((e: ShadowEvent) => e.eventType)).toEqual([
      "tool.request",
      "tool.response",
    ]);
    expect((lateEvents[0]?.metadata as { otel: { late?: boolean } }).otel.late).toBe(true);
    expect(detail.trace.metrics.toolCalls).toBe(3);
  });

  it("rejects protobuf and malformed bodies", async () => {
    const proto = await t.app.inject({
      method: "POST",
      url: "/api/v1/otlp/v1/traces",
      headers: { "content-type": "application/x-protobuf" },
      payload: Buffer.from([0x0a, 0x00]),
    });
    expect(proto.statusCode).toBe(415);
    const bad = await t.app.inject({
      method: "POST",
      url: "/api/v1/otlp/v1/traces",
      payload: { resourceSpans: "nope" },
    });
    expect(bad.statusCode).toBe(400);
    const empty = await t.app.inject({
      method: "POST",
      url: "/api/v1/otlp/v1/traces",
      payload: {},
    });
    expect(empty.statusCode).toBe(200);
    expect(json(empty)).toEqual({ partialSuccess: {}, shadow: { traces: [] } });
  });
});
