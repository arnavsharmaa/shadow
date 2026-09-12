import type { OtlpKeyValue, OtlpSpan, OtlpTracesPayload } from "../../src/otlp/convert.js";

const T0 = 1_788_253_924_000_000_000n; // 2026-09-01T09:12:04Z in ns
export const ms = (offset: number) => String(T0 + BigInt(offset) * 1_000_000n);

export function kv(key: string, value: unknown): OtlpKeyValue {
  if (typeof value === "string") return { key, value: { stringValue: value } };
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  if (typeof value === "number")
    return Number.isInteger(value)
      ? { key, value: { intValue: String(value) } }
      : { key, value: { doubleValue: value } };
  return { key, value: { stringValue: JSON.stringify(value) } };
}

export function span(input: Partial<OtlpSpan> & { spanId: string; name: string }): OtlpSpan {
  return { traceId: "4bf92f3577b34da6a3ce929d0e0e4736", kind: 1, ...input };
}

export function refundPayload(): OtlpTracesPayload {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [kv("service.name", "refund-agent"), kv("service.namespace", "support")],
        },
        scopeSpans: [
          {
            scope: { name: "example.instrumentation" },
            spans: [
              span({
                spanId: "00f067aa0ba902b7",
                name: "invoke_agent refund-agent",
                kind: 2,
                startTimeUnixNano: ms(0),
                endTimeUnixNano: ms(4000),
                attributes: [
                  kv("gen_ai.operation.name", "invoke_agent"),
                  kv("gen_ai.agent.name", "refund-agent"),
                ],
                status: { code: 2, message: "refund exceeded limit" },
              }),
              span({
                spanId: "a1b2c3d4e5f60001",
                parentSpanId: "00f067aa0ba902b7",
                name: "chat shadow-sim-large",
                kind: 3,
                startTimeUnixNano: ms(100),
                endTimeUnixNano: ms(900),
                attributes: [
                  kv("gen_ai.operation.name", "chat"),
                  kv("gen_ai.provider.name", "shadow-sim"),
                  kv("gen_ai.request.model", "shadow-sim-large"),
                  kv("gen_ai.request.temperature", 0.2),
                  kv("gen_ai.usage.input_tokens", 120),
                  kv("gen_ai.usage.output_tokens", 30),
                  kv("gen_ai.response.finish_reasons", ["tool_calls"]),
                  kv("gen_ai.input.messages", [
                    { role: "system", parts: [{ type: "text", content: "You refund things." }] },
                    { role: "user", parts: [{ type: "text", content: "Refund my order." }] },
                  ]),
                  kv("gen_ai.output.messages", [
                    {
                      role: "assistant",
                      parts: [
                        {
                          type: "tool_call",
                          name: "refund_order",
                          arguments: { orderId: "ord_5001", amount: 480 },
                        },
                      ],
                    },
                  ]),
                ],
              }),
              span({
                spanId: "a1b2c3d4e5f60002",
                parentSpanId: "00f067aa0ba902b7",
                name: "execute_tool refund_order",
                kind: 1,
                startTimeUnixNano: ms(1000),
                endTimeUnixNano: ms(1900),
                attributes: [
                  kv("gen_ai.operation.name", "execute_tool"),
                  kv("gen_ai.tool.name", "refund_order"),
                  kv("gen_ai.tool.call.arguments", { orderId: "ord_5001", amount: 480 }),
                  kv("gen_ai.tool.call.result", { status: "processed", refundId: "rf_5001" }),
                ],
                events: [
                  {
                    timeUnixNano: ms(1050),
                    name: "shadow.policy.evaluated",
                    attributes: [
                      kv("policy", "refund.autonomous_limit"),
                      kv("decision", "deny"),
                      kv("reason", "amount above limit"),
                      kv("subject", { amount: 480 }),
                    ],
                  },
                  {
                    timeUnixNano: ms(1010),
                    name: "shadow.context.set",
                    attributes: [kv("key", "refundLimit"), kv("value", 100)],
                  },
                ],
              }),
              span({
                spanId: "a1b2c3d4e5f60003",
                parentSpanId: "00f067aa0ba902b7",
                name: "POST /email",
                kind: 3,
                startTimeUnixNano: ms(2000),
                endTimeUnixNano: ms(2500),
                attributes: [
                  kv("http.request.method", "POST"),
                  kv("url.full", "https://mail.example.com/send"),
                  kv("http.response.status_code", 502),
                  kv("error.type", "502"),
                ],
                status: { code: "STATUS_CODE_ERROR", message: "bad gateway" },
              }),
              span({
                spanId: "a1b2c3d4e5f60004",
                parentSpanId: "a1b2c3d4e5f60002",
                name: "compute",
                kind: 1,
                startTimeUnixNano: ms(1100),
                endTimeUnixNano: ms(1200),
              }),
            ],
          },
        ],
      },
    ],
  };
}
