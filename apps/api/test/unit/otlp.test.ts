import { describe, expect, it } from "vitest";
import {
  anyValue,
  attributes,
  convertOtlpTraces,
  type OtlpSpan,
  type OtlpTracesPayload,
} from "../../src/otlp/convert.js";
import { kv, ms, refundPayload, span } from "../fixtures/otlp.js";

describe("OTLP value decoding", () => {
  it("decodes AnyValue variants", () => {
    expect(anyValue({ stringValue: "x" })).toBe("x");
    expect(anyValue({ intValue: "42" })).toBe(42);
    expect(anyValue({ intValue: "99999999999999999999" })).toBe("99999999999999999999");
    expect(anyValue({ doubleValue: 1.5 })).toBe(1.5);
    expect(anyValue({ boolValue: false })).toBe(false);
    expect(anyValue({ arrayValue: { values: [{ stringValue: "a" }, { intValue: 1 }] } })).toEqual([
      "a",
      1,
    ]);
    expect(
      anyValue({ kvlistValue: { values: [{ key: "k", value: { stringValue: "v" } }] } }),
    ).toEqual({ k: "v" });
    expect(anyValue(undefined)).toBeNull();
    expect(attributes([{ key: "a", value: { stringValue: "1" } }, { key: "b" }])).toEqual({
      a: "1",
      b: null,
    });
  });
});

describe("convertOtlpTraces", () => {
  it("maps GenAI, tool, HTTP and generic spans into an ordered Shadow trace", () => {
    const [trace, ...rest] = convertOtlpTraces(refundPayload(), { defaultProject: "otel" });
    expect(rest).toHaveLength(0);
    expect(trace).toMatchObject({
      traceId: "trc_otel_4bf92f3577b34da6a3ce929d0e0e4736",
      project: "support",
      agent: "refund-agent",
      name: "invoke_agent refund-agent",
      startedAt: "2026-09-01T09:12:04.000Z",
      complete: true,
    });
    const events = trace?.events ?? [];
    expect(events.map((e) => `${e.eventType}:${e.name}`)).toEqual([
      "trace.started:trace.started",
      "agent.started:refund-agent",
      "model.request:shadow-sim-large",
      "model.response:shadow-sim-large",
      "tool.request:refund_order",
      "context.added:refundLimit",
      "policy.evaluated:refund.autonomous_limit",
      "otel.span_started:compute",
      "otel.span_ended:compute",
      "tool.response:refund_order",
      "tool.request:POST /email",
      "tool.error:POST /email",
      "agent.completed:refund-agent",
      "trace.failed:trace.failed",
    ]);
    // The root invoke_agent span is the agent span: no duplicate wrapper.
    expect(events.filter((e) => e.eventType === "agent.started")).toHaveLength(1);
    const agentStart = events[1];
    expect(agentStart?.id).toBe("evt_otel_00f067aa0ba902b7_start");
    expect(agentStart?.spanId).toBe("spn_00f067aa0ba902b7");
    expect(agentStart?.parentSpanId).toBeNull();

    const modelRequest = events[2];
    expect(modelRequest?.parentEventId).toBe("evt_otel_00f067aa0ba902b7_start");
    expect(modelRequest?.parentSpanId).toBe("spn_00f067aa0ba902b7");
    expect(modelRequest?.input).toEqual({
      provider: "shadow-sim",
      model: "shadow-sim-large",
      messages: [
        { role: "system", content: [{ type: "text", content: "You refund things." }] },
        { role: "user", content: [{ type: "text", content: "Refund my order." }] },
      ],
      parameters: { temperature: 0.2 },
    });
    const modelResponse = events[3];
    expect(modelResponse?.tokenUsage).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
    });
    expect(modelResponse?.durationMs).toBe(800);
    expect(modelResponse?.parentEventId).toBe(modelRequest?.id);
    expect(modelResponse?.output).toMatchObject({
      finishReason: "tool_calls",
      toolCalls: [{ tool: "refund_order", arguments: { orderId: "ord_5001", amount: 480 } }],
    });

    const toolRequest = events[4];
    expect(toolRequest?.input).toEqual({
      tool: "refund_order",
      arguments: { orderId: "ord_5001", amount: 480 },
    });
    expect(events[5]?.output).toEqual({ key: "refundLimit", value: 100 });
    expect(events[6]?.output).toEqual({
      policy: "refund.autonomous_limit",
      decision: "deny",
      reason: "amount above limit",
      subject: { amount: 480 },
    });
    expect(events[6]?.severity).toBe("warn");
    expect(events[6]?.parentEventId).toBe(toolRequest?.id);
    expect(events[7]?.parentEventId).toBe(toolRequest?.id);
    expect(events[9]?.output).toEqual({ result: { status: "processed", refundId: "rf_5001" } });

    expect(events[10]?.input).toEqual({
      tool: "POST /email",
      arguments: {
        "http.request.method": "POST",
        "url.full": "https://mail.example.com/send",
        "http.response.status_code": 502,
      },
    });
    expect(events[11]?.output).toEqual({ error: { message: "bad gateway", code: "502" } });
    expect(events[11]?.severity).toBe("error");

    expect(events[13]?.output).toEqual({
      outcome: { kind: "error", label: "Failed: refund exceeded limit" },
    });
    expect(events[13]?.timestamp).toBe("2026-09-01T09:12:08.000Z");
    const otel = (events[2]?.metadata as { otel: Record<string, unknown> }).otel;
    expect(otel).toMatchObject({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "a1b2c3d4e5f60001",
      kind: "CLIENT",
      scope: "example.instrumentation",
      semconv: "1.36.0",
    });
  });

  it("wraps a non-agent root span, falls back to prompt events and flags missing content", () => {
    const payload: OtlpTracesPayload = {
      resourceSpans: [
        {
          resource: { attributes: [kv("service.name", "assistant")] },
          scopeSpans: [
            {
              spans: [
                span({
                  traceId: "aa",
                  spanId: "r1",
                  name: "handle request",
                  startTimeUnixNano: ms(0),
                  endTimeUnixNano: ms(50),
                }),
                span({
                  traceId: "aa",
                  spanId: "m1",
                  parentSpanId: "r1",
                  name: "chat",
                  startTimeUnixNano: ms(10),
                  endTimeUnixNano: ms(40),
                  attributes: [
                    kv("gen_ai.operation.name", "chat"),
                    kv("gen_ai.system", "openai"),
                    kv("gen_ai.request.model", "gpt-x"),
                  ],
                  events: [
                    {
                      name: "gen_ai.content.prompt",
                      attributes: [kv("gen_ai.prompt", [{ role: "user", content: "hi" }])],
                    },
                    {
                      name: "gen_ai.content.completion",
                      attributes: [kv("gen_ai.completion", [{ role: "model", content: "hello" }])],
                    },
                  ],
                }),
                span({
                  traceId: "aa",
                  spanId: "m2",
                  parentSpanId: "r1",
                  name: "chat",
                  startTimeUnixNano: ms(41),
                  endTimeUnixNano: ms(45),
                  attributes: [kv("gen_ai.operation.name", "chat"), kv("gen_ai.system", "openai")],
                }),
                span({
                  traceId: "bb",
                  spanId: "open",
                  name: "still running",
                  startTimeUnixNano: ms(0),
                }),
              ],
            },
          ],
        },
      ],
    };
    const traces = convertOtlpTraces(payload, { defaultProject: "fallback" });
    expect(traces.map((t) => [t.traceId, t.project, t.complete])).toEqual([
      ["trc_otel_aa", "fallback", true],
      ["trc_otel_bb", "fallback", false],
    ]);
    const a = traces[0]?.events ?? [];
    expect(a.map((e) => e.eventType)).toEqual([
      "trace.started",
      "agent.started",
      "otel.span_started",
      "model.request",
      "model.response",
      "model.request",
      "model.response",
      "otel.span_ended",
      "agent.completed",
      "trace.completed",
    ]);
    expect(a[2]?.parentEventId).toBe("evt_otel_aa_agent_start");
    expect(a[2]?.parentSpanId).toBe("spn_aa_agent");
    expect(a[3]?.input).toMatchObject({
      provider: "openai",
      model: "gpt-x",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(a[4]?.output).toEqual({ message: { role: "assistant", content: "hello" } });
    expect((a[5]?.metadata as { otel: { contentMissing?: boolean } }).otel.contentMissing).toBe(
      true,
    );
    expect(a[9]?.output).toEqual({ outcome: { kind: "completed", label: "Completed" } });

    const b = traces[1]?.events ?? [];
    expect(b.map((e) => e.eventType)).toEqual([
      "trace.started",
      "agent.started",
      "otel.span_started",
    ]);
  });

  it("ignores malformed spans and empty payloads", () => {
    expect(convertOtlpTraces({}, { defaultProject: "p" })).toEqual([]);
    expect(
      convertOtlpTraces(
        { resourceSpans: [{ scopeSpans: [{ spans: [{ name: "x" } as unknown as OtlpSpan] }] }] },
        { defaultProject: "p" },
      ),
    ).toEqual([]);
  });
});
