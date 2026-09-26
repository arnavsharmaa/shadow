import type { ShadowEvent } from "@shadow/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OtlpKeyValue, OtlpSpan, OtlpTracesPayload } from "../../src/otlp/convert.js";
import { anyValue } from "../../src/otlp/convert.js";
import { otelTraceIdFor } from "../../src/otlp/export.js";
import { decodeOtlpProtobuf } from "../../src/otlp/protobuf.js";
import {
  createTestApp,
  forkReplayCompare,
  ingestRefundScenario,
  json,
  listAllEvents,
  type ForkedScenario,
  type RefundScenario,
  type TestApp,
} from "../helpers.js";

let t: TestApp;
let scenario: RefundScenario;
let forked: ForkedScenario;

beforeAll(async () => {
  t = await createTestApp();
  scenario = await ingestRefundScenario(t, "trc_test_otlp_export");
  forked = await forkReplayCompare(t, scenario);
});

afterAll(async () => {
  await t.close();
});

function attrs(list: OtlpKeyValue[] | undefined): Record<string, unknown> {
  return Object.fromEntries((list ?? []).map((kv) => [kv.key, anyValue(kv.value)]));
}

function spansOf(payload: OtlpTracesPayload): OtlpSpan[] {
  return (
    payload.resourceSpans?.flatMap((r) => r.scopeSpans?.flatMap((s) => s.spans ?? []) ?? []) ?? []
  );
}

describe("GET /api/v1/traces/:traceId/export?format=otlp", () => {
  it("exports every branch as an OpenTelemetry trace with GenAI attributes", async () => {
    const response = await t.app.inject({
      method: "GET",
      url: `/api/v1/traces/${scenario.traceId}/export?format=otlp`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-disposition"]).toContain(".otlp.json");
    const payload = json<OtlpTracesPayload>(response);
    const resource = attrs(payload.resourceSpans?.[0]?.resource?.attributes);
    expect(resource).toMatchObject({
      "service.namespace": "support-agent",
      "service.name": "refund-agent",
      "shadow.trace.id": scenario.traceId,
      "shadow.trace.tags": ["refund", "test"],
    });

    const spans = spansOf(payload);
    const rootTrace = otelTraceIdFor(scenario.traceId, scenario.rootBranchId);
    const forkTrace = otelTraceIdFor(scenario.traceId, forked.branch.id);
    const otelTraces = new Set(spans.map((s) => s.traceId));
    expect(otelTraces).toEqual(new Set([rootTrace, forkTrace]));
    for (const span of spans) {
      expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
      expect(BigInt(String(span.endTimeUnixNano))).toBeGreaterThanOrEqual(
        BigInt(String(span.startTimeUnixNano)),
      );
    }

    // Every Shadow span of the root branch is one OTel span, parented under the branch root.
    const rootSpans = spans.filter((s) => s.traceId === rootTrace);
    const root = rootSpans.find((s) => !s.parentSpanId);
    expect(root).toBeDefined();
    expect(attrs(root?.attributes)).toMatchObject({
      "gen_ai.operation.name": "invoke_agent",
      "shadow.branch.name": "main",
      "shadow.branch.status": "failed",
    });
    expect(root?.status).toEqual({ code: 2 });
    const spanEvents = scenario.rootEvents.filter((e: ShadowEvent) => e.spanId !== null);
    const openers = new Set(spanEvents.map((e: ShadowEvent) => e.spanId));
    expect(rootSpans.length).toBe(openers.size + 1);

    const refund = rootSpans.find((s) => s.name === "execute_tool refund_order");
    expect(refund).toBeDefined();
    const refundAttrs = attrs(refund?.attributes);
    expect(refundAttrs["gen_ai.operation.name"]).toBe("execute_tool");
    expect(refundAttrs["gen_ai.tool.name"]).toBe("refund_order");
    expect(JSON.parse(String(refundAttrs["gen_ai.tool.call.arguments"]))).toMatchObject({
      orderId: expect.any(String),
      amount: 480,
    });
    expect(JSON.parse(String(refundAttrs["gen_ai.tool.call.result"]))).toMatchObject({
      status: "processed",
    });
    expect(refund?.status).toEqual({ code: 1 });
    // The guard's policy evaluation rides along as a reserved span event; the opener and
    // closer themselves are the span, not span events.
    expect(refund?.events?.map((e) => e.name)).toEqual([
      "shadow.policy.evaluated",
      "policy.allowed",
    ]);
    const policy = refund?.events?.find((e) => e.name === "shadow.policy.evaluated");
    expect(attrs(policy?.attributes)).toMatchObject({
      policy: "refund.autonomous_limit",
      decision: "allow",
    });

    const model = rootSpans.find((s) => s.name?.startsWith("chat "));
    const modelAttrs = attrs(model?.attributes);
    expect(model?.kind).toBe(3);
    expect(modelAttrs["gen_ai.operation.name"]).toBe("chat");
    expect(modelAttrs["gen_ai.provider.name"]).toBe("shadow-sim");
    expect(typeof modelAttrs["gen_ai.usage.input_tokens"]).toBe("number");
    expect(JSON.parse(String(modelAttrs["gen_ai.input.messages"]))[0]).toMatchObject({
      role: "system",
    });

    // Context writes become shadow.context.set span events on the span that recorded them.
    const contextSets = rootSpans.flatMap((s) =>
      (s.events ?? []).filter((e) => e.name === "shadow.context.set"),
    );
    expect(contextSets.map((e) => attrs(e.attributes).key)).toContain("refundLimit");

    // The fork branch is a separate OTel trace linked back to its parent's root span.
    const forkRoot = spans.find((s) => s.traceId === forkTrace && !s.parentSpanId);
    expect(forkRoot?.links?.[0]).toMatchObject({
      traceId: rootTrace,
      spanId: root?.spanId,
    });
    expect(attrs(forkRoot?.links?.[0]?.attributes)).toMatchObject({
      "shadow.link": "forked_from",
      "shadow.fork.event_id": forked.forkEvent.id,
    });
    expect(attrs(forkRoot?.attributes)["shadow.branch.name"]).toBe(forked.branch.name);
  });

  it("serves the protobuf encoding on request", async () => {
    const byQuery = await t.app.inject({
      method: "GET",
      url: `/api/v1/traces/${scenario.traceId}/export?format=otlp&encoding=protobuf`,
    });
    expect(byQuery.statusCode).toBe(200);
    expect(byQuery.headers["content-type"]).toBe("application/x-protobuf");
    expect(byQuery.headers["content-disposition"]).toContain(".otlp.bin");
    const decoded = decodeOtlpProtobuf(byQuery.rawPayload);
    const asJson = json<OtlpTracesPayload>(
      await t.app.inject({
        method: "GET",
        url: `/api/v1/traces/${scenario.traceId}/export?format=otlp`,
      }),
    );
    expect(spansOf(decoded).map((s) => [s.traceId, s.spanId, s.name])).toEqual(
      spansOf(asJson).map((s) => [s.traceId, s.spanId, s.name]),
    );

    const byAccept = await t.app.inject({
      method: "GET",
      url: `/api/v1/traces/${scenario.traceId}/export?format=otlp`,
      headers: { accept: "application/x-protobuf" },
    });
    expect(byAccept.headers["content-type"]).toBe("application/x-protobuf");
    expect(byAccept.rawPayload.equals(byQuery.rawPayload)).toBe(true);
  });

  it("round-trips through the OTLP importer", async () => {
    const payload = json<OtlpTracesPayload>(
      await t.app.inject({
        method: "GET",
        url: `/api/v1/traces/${scenario.traceId}/export?format=otlp`,
      }),
    );
    const imported = await t.app.inject({
      method: "POST",
      url: "/api/v1/otlp/v1/traces",
      payload,
    });
    expect(imported.statusCode).toBe(200);
    const result = json<{ shadow: { traces: { traceId: string; created: boolean }[] } }>(imported);
    expect(result.shadow.traces).toHaveLength(2);
    const rootTrace = otelTraceIdFor(scenario.traceId, scenario.rootBranchId);
    const reimported = `trc_otel_${rootTrace}`;
    expect(result.shadow.traces.map((r) => r.traceId)).toContain(reimported);

    const detail = json<{
      trace: { rootBranchId: string; agentSlug: string; projectSlug: string };
    }>(await t.app.inject({ method: "GET", url: `/api/v1/traces/${reimported}` }));
    expect(detail.trace).toMatchObject({ projectSlug: "support-agent", agentSlug: "refund-agent" });
    const events = await listAllEvents(t, reimported, { branchId: detail.trace.rootBranchId });
    const signature = (list: ShadowEvent[]) =>
      list
        .filter((e) => e.eventType.startsWith("tool.") || e.eventType.startsWith("model."))
        .map((e) => `${e.eventType} ${e.name}`);
    expect(signature(events)).toEqual(signature(scenario.rootEvents));
    const policies = events.filter((e: ShadowEvent) => e.eventType === "policy.evaluated");
    expect(policies.map((e: ShadowEvent) => e.name)).toEqual(
      scenario.rootEvents
        .filter((e: ShadowEvent) => e.eventType === "policy.evaluated")
        .map((e: ShadowEvent) => e.name),
    );
    const state = json<{ context: Record<string, unknown> }>(
      await t.app.inject({
        method: "GET",
        url: `/api/v1/branches/${detail.trace.rootBranchId}/state`,
      }),
    );
    expect(state.context).toMatchObject({ refundLimit: 500 });
  });

  it("rejects unknown formats", async () => {
    const response = await t.app.inject({
      method: "GET",
      url: `/api/v1/traces/${scenario.traceId}/export?format=csv`,
    });
    expect(response.statusCode).toBe(400);
  });
});
