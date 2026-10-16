import { importOpenAIBodySchema } from "@shadow/schemas";
import { describe, expect, it } from "vitest";
import { convertOpenAIMessages } from "../../src/importers/openai.js";
import { openAIRefundConversation } from "../fixtures/openai.js";

function ids() {
  let n = 0;
  return { nextId: (prefix: "evt" | "spn") => `${prefix}_${++n}`, now: 0 };
}

describe("convertOpenAIMessages", () => {
  it("maps a function-calling loop to model and tool spans in conversation order", () => {
    const { events, summary, name, startedAt } = convertOpenAIMessages(
      openAIRefundConversation(),
      ids(),
    );
    expect(name).toBe("ticket-1234: defective headphones");
    expect(startedAt).toBe("2026-09-30T09:00:00.000Z");
    expect(summary).toEqual({
      turns: 3,
      toolCalls: 2,
      unmatchedToolCalls: 0,
      orphanToolResults: 0,
      finishReason: "stop",
    });
    expect(events.map((e) => `${e.eventType} ${e.name}`)).toEqual([
      "trace.started ticket-1234: defective headphones",
      "agent.started gpt-refund-agent",
      "context.added tools",
      "state.patch /messages",
      "context.added system",
      "state.patch /messages/-",
      "state.patch /messages/-",
      "model.request turn-1",
      "model.response turn-1",
      "tool.request lookup_order",
      "state.patch /messages/-",
      "tool.response lookup_order",
      "state.patch /messages/-",
      "model.request turn-2",
      "model.response turn-2",
      "tool.request refund_order",
      "state.patch /messages/-",
      "tool.error refund_order",
      "state.patch /messages/-",
      "model.request turn-3",
      "model.response turn-3",
      "state.patch /messages/-",
      "agent.completed gpt-refund-agent",
      "trace.completed trace.completed",
    ]);
    expect(events.every((e) => e.source === "openai")).toBe(true);
    expect(events.map((e) => e.timestamp)).toEqual([...events.map((e) => e.timestamp)].sort());
  });

  it("carries models, finish reasons, usage, parsed arguments and tool pairing", () => {
    const { events } = convertOpenAIMessages(openAIRefundConversation(), ids());
    const byName = (type: string, name: string) =>
      events.find((e) => e.eventType === type && e.name === name);
    expect(byName("context.added", "tools")?.output).toEqual({
      key: "tools",
      value: ["lookup_order", "refund_order"],
    });
    expect(byName("context.added", "system")?.output).toMatchObject({ key: "system" });
    const first = byName("model.request", "turn-1");
    expect(first?.input).toMatchObject({
      provider: "openai",
      model: "gpt-5",
      parameters: { tools: ["lookup_order", "refund_order"] },
    });
    expect((first?.input as { messages: unknown[] }).messages).toHaveLength(2);
    const response1 = byName("model.response", "turn-1");
    expect(response1?.output).toMatchObject({
      finishReason: "tool_calls",
      toolCalls: [
        { tool: "lookup_order", arguments: { orderId: "ord_5001" }, id: "call_lookup_1" },
      ],
    });
    expect(response1?.tokenUsage).toEqual({ inputTokens: 310, outputTokens: 24, totalTokens: 334 });
    expect(response1?.metadata).toEqual({ openai: { responseId: "chatcmpl_1" } });
    expect(byName("model.response", "turn-2")?.tokenUsage).toEqual({
      inputTokens: 380,
      outputTokens: 28,
      totalTokens: 408,
      cachedInputTokens: 256,
    });
    // The second request carries only what was added since the first call.
    expect((byName("model.request", "turn-2")?.input as { messages: unknown[] }).messages).toEqual([
      { role: "tool", content: expect.objectContaining({ tool_call_id: "call_lookup_1" }) },
    ]);
    const lookup = byName("tool.request", "lookup_order");
    expect(lookup?.input).toEqual({ tool: "lookup_order", arguments: { orderId: "ord_5001" } });
    const lookupResult = byName("tool.response", "lookup_order");
    expect(lookupResult?.parentEventId).toBe(lookup?.id);
    expect(lookupResult?.spanId).toBe(lookup?.spanId);
    expect(lookupResult?.output).toEqual({
      result: { orderId: "ord_5001", total: 480, currency: "USD", status: "delivered" },
    });
    const refundError = byName("tool.error", "refund_order");
    expect(refundError?.output).toEqual({
      error: {
        message: "amount $480 exceeds the autonomous limit of $100; human approval required",
      },
    });
    expect(byName("model.response", "turn-3")?.output).toMatchObject({ finishReason: "stop" });
    expect(events.at(-1)?.output).toMatchObject({
      outcome: {
        kind: "completed",
        label: "Completed",
        summary: expect.stringContaining("refund"),
      },
    });
  });

  it("infers finish reasons, names the trace from the first message and reports loose ends", () => {
    const body = importOpenAIBodySchema.parse({
      messages: [
        { role: "user", content: "   Please cancel my   subscription now, it renews tomorrow" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "c1", type: "function", function: { name: "cancel", arguments: "{bad json" } },
            { id: "c2", type: "function", function: { name: "notify", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "c1", content: "cancelled" },
        { role: "tool", tool_call_id: "nope", content: "?" },
      ],
    });
    const { events, summary, name } = convertOpenAIMessages(body, { ...ids(), now: 5_000 });
    expect(name).toBe("   Please cancel my   subscription now, it renews tomorrow");
    expect(summary).toEqual({
      turns: 1,
      toolCalls: 2,
      unmatchedToolCalls: 1,
      orphanToolResults: 1,
      finishReason: "tool_calls",
    });
    expect(events[0]?.timestamp).toBe("1970-01-01T00:00:05.000Z");
    const response = events.find((e) => e.eventType === "model.response");
    expect(response?.input).toBeUndefined();
    expect(response?.metadata).toEqual({ openai: { finishReasonInferred: true } });
    expect(response?.output).toMatchObject({
      toolCalls: [
        { tool: "cancel", arguments: "{bad json" },
        { tool: "notify", arguments: {} },
      ],
    });
    expect(events.find((e) => e.eventType === "tool.response")?.output).toEqual({
      result: "cancelled",
    });
    expect(events.at(-1)?.output).toEqual({
      outcome: { kind: "incomplete", label: "Conversation in progress" },
    });
    expect(events.find((e) => e.eventType === "model.request")?.input).toMatchObject({
      model: "unknown",
    });
  });

  it("labels truncated and filtered endings and developer messages mid-conversation", () => {
    const truncated = convertOpenAIMessages(
      importOpenAIBodySchema.parse({
        agent: "bot",
        model: "gpt-5-mini",
        messages: [
          { role: "developer", content: [{ type: "text", text: "Be terse." }] },
          { role: "user", content: "hi" },
          { role: "assistant", content: "a very long" },
          { role: "developer", content: "Stop." },
          { role: "assistant", content: "ok" },
        ],
        responses: [{ finish_reason: "length" }, { finish_reason: "content_filter" }],
      }),
      ids(),
    );
    const contexts = truncated.events.filter((e) => e.eventType === "context.added");
    expect(contexts.map((e) => e.output)).toEqual([
      { key: "system", value: "Be terse." },
      { key: "system", value: "Stop." },
    ]);
    expect(contexts[1]?.metadata).toEqual({ openai: { role: "developer", midConversation: true } });
    const responses = truncated.events.filter((e) => e.eventType === "model.response");
    expect(responses.map((e) => e.severity)).toEqual(["warn", "warn"]);
    expect(responses[0]?.input).toBeUndefined();
    expect(truncated.events.at(-1)?.output).toEqual({
      outcome: { kind: "refusal", label: "Stopped by the content filter", summary: "ok" },
    });
    expect(truncated.events.find((e) => e.eventType === "model.request")?.input).toMatchObject({
      model: "gpt-5-mini",
    });
    const cut = convertOpenAIMessages(
      importOpenAIBodySchema.parse({
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "a very long" },
        ],
        responses: [{ finish_reason: "length" }],
      }),
      ids(),
    );
    expect(cut.events.at(-1)?.output).toEqual({
      outcome: { kind: "truncated", label: "Stopped at max tokens", summary: "a very long" },
    });
  });
});
