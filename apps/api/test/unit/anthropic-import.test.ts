import { importAnthropicBodySchema } from "@shadow/schemas";
import { describe, expect, it } from "vitest";
import { convertAnthropicMessages } from "../../src/importers/anthropic.js";
import { refundConversation } from "../fixtures/anthropic.js";

function ids() {
  let n = 0;
  return { nextId: (prefix: "evt" | "spn") => `${prefix}_${++n}`, now: 0 };
}

describe("convertAnthropicMessages", () => {
  it("maps a tool-use loop to model and tool spans in conversation order", () => {
    const { events, summary, name, startedAt } = convertAnthropicMessages(
      refundConversation(),
      ids(),
    );
    expect(name).toBe("ticket-1234: defective headphones");
    expect(startedAt).toBe("2026-09-30T09:00:00.000Z");
    expect(summary).toEqual({
      turns: 3,
      toolCalls: 2,
      serverToolCalls: 1,
      unmatchedToolUses: 0,
      orphanToolResults: 0,
      stopReason: "end_turn",
    });
    expect(events.map((e) => `${e.eventType} ${e.name}`)).toEqual([
      "trace.started ticket-1234: defective headphones",
      "agent.started claude-refund-agent",
      "context.added system",
      "context.added tools",
      "state.patch /messages",
      "state.patch /messages/-",
      "model.request turn-1",
      "model.response turn-1",
      "agent.note thinking",
      "tool.request lookup_order",
      "state.patch /messages/-",
      "tool.response lookup_order",
      "state.patch /messages/-",
      "model.request turn-2",
      "model.response turn-2",
      "tool.request web_search",
      "tool.response web_search",
      "tool.request refund_order",
      "state.patch /messages/-",
      "tool.error refund_order",
      "state.patch /messages/-",
      "model.request turn-3",
      "model.response turn-3",
      "state.patch /messages/-",
      "agent.completed claude-refund-agent",
      "trace.completed trace.completed",
    ]);
    // Timestamps advance one millisecond per event and every event is tagged with its source.
    expect(events.map((e) => e.timestamp)).toEqual(
      events.map((_, i) => new Date(Date.parse(startedAt) + i).toISOString()),
    );
    expect(events.every((e) => e.source === "anthropic")).toBe(true);
  });

  it("carries models, stop reasons, usage, tool pairing and server tools", () => {
    const { events } = convertAnthropicMessages(refundConversation(), ids());
    const find = (type: string, name: string, nth = 0) =>
      events.filter((e) => e.eventType === type && e.name === name)[nth];

    const firstRequest = find("model.request", "turn-1");
    expect(firstRequest?.input).toMatchObject({
      provider: "anthropic",
      model: "claude-opus-5-5",
      parameters: { tools: ["lookup_order", "refund_order", "web_search"] },
      messages: [{ role: "system" }, { role: "user" }],
    });
    // Later requests only carry the turns added since the previous call.
    expect(find("model.request", "turn-2")?.input).toMatchObject({
      messages: [{ role: "user", content: [{ type: "tool_result" }] }],
    });

    const second = find("model.response", "turn-2");
    expect(second?.parentEventId).toBe(find("model.request", "turn-2")?.id);
    expect(second?.output).toMatchObject({
      finishReason: "tool_use",
      toolCalls: [
        {
          tool: "refund_order",
          arguments: { orderId: "ord_5001", amount: 480 },
          id: "toolu_02refund",
        },
      ],
    });
    expect(second?.tokenUsage).toEqual({
      inputTokens: 96,
      outputTokens: 74,
      totalTokens: 170,
      cachedInputTokens: 412,
    });
    expect(second?.metadata).toEqual({
      anthropic: { responseId: "msg_01b", usage: { cache_creation_input_tokens: 120 } },
    });

    const lookup = find("tool.request", "lookup_order");
    const lookupResult = find("tool.response", "lookup_order");
    expect(lookupResult).toMatchObject({ spanId: lookup?.spanId, parentEventId: lookup?.id });
    expect(lookup?.metadata).toEqual({ anthropic: { toolUseId: "toolu_01lookup" } });

    const refundError = find("tool.error", "refund_order");
    expect(refundError).toMatchObject({
      severity: "error",
      output: { error: { message: "amount $480 exceeds the autonomous limit of $100" } },
    });
    expect(find("tool.request", "web_search")?.metadata).toEqual({
      anthropic: { server: true, toolUseId: "srvtoolu_01search" },
    });
    expect(find("agent.note", "thinking")).toMatchObject({
      severity: "debug",
      output: { text: "I should look the order up before deciding anything." },
    });
    expect(find("trace.completed", "trace.completed")?.output).toMatchObject({
      outcome: { kind: "completed", label: "Completed" },
    });
  });

  it("infers stop reasons, names the trace from the first message and reports loose ends", () => {
    const body = importAnthropicBodySchema.parse({
      messages: [
        { role: "user", content: "What is the weather in Paris?" },
        {
          role: "assistant",
          content: [
            { type: "redacted_thinking", data: "opaque" },
            { type: "tool_use", id: "toolu_a", name: "get_weather", input: { city: "Paris" } },
            { type: "tool_use", name: "no_id", input: {} },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_unknown", content: "?" }],
        },
        { role: "system", content: "Terse mode enabled." },
      ],
    });
    expect(body).toMatchObject({ project: "anthropic", agent: "claude-agent", tags: [] });
    const { events, summary, name } = convertAnthropicMessages(body, { ...ids(), now: 1000 });
    expect(name).toBe("What is the weather in Paris?");
    expect(events[0]?.timestamp).toBe("1970-01-01T00:00:01.000Z");
    expect(summary).toMatchObject({
      turns: 1,
      toolCalls: 2,
      unmatchedToolUses: 1,
      orphanToolResults: 1,
      stopReason: "tool_use",
    });
    const response = events.find((e) => e.eventType === "model.response");
    expect(response?.output).toMatchObject({ finishReason: "tool_use" });
    expect(response?.metadata).toEqual({ anthropic: { stopReasonInferred: true } });
    expect(response?.tokenUsage).toBeNull();
    expect(events.find((e) => e.eventType === "agent.note")?.output).toEqual({ redacted: true });
    const mid = events.filter((e) => e.eventType === "context.added");
    expect(mid).toHaveLength(1);
    expect(mid[0]).toMatchObject({
      output: { key: "system", value: "Terse mode enabled." },
      metadata: { anthropic: { midConversation: true } },
    });
    expect(events.at(-1)?.output).toMatchObject({
      outcome: { kind: "incomplete", label: "Conversation in progress" },
    });
  });

  it("labels truncated and refused endings and server tool errors", () => {
    const ending = (stop_reason: string) =>
      convertAnthropicMessages(
        importAnthropicBodySchema.parse({
          messages: [
            { role: "user", content: "hi" },
            {
              role: "assistant",
              content: [
                { type: "server_tool_use", id: "srv_1", name: "web_fetch", input: { url: "x" } },
                {
                  type: "web_fetch_tool_result",
                  tool_use_id: "srv_1",
                  content: {
                    type: "web_fetch_tool_result_error",
                    error_code: "url_not_accessible",
                  },
                },
                { type: "text", text: "partial" },
              ],
            },
          ],
          responses: [{ stop_reason }],
        }),
        ids(),
      );
    const truncated = ending("max_tokens");
    expect(truncated.events.at(-1)?.output).toMatchObject({
      outcome: { kind: "truncated", label: "Stopped at max_tokens", summary: "partial" },
    });
    expect(truncated.events.find((e) => e.eventType === "model.response")?.severity).toBe("warn");
    expect(truncated.events.find((e) => e.eventType === "tool.error")?.output).toEqual({
      error: { message: "url_not_accessible", code: "url_not_accessible" },
    });
    expect(ending("refusal").events.at(-1)?.output).toMatchObject({
      outcome: { kind: "refusal", label: "Model refused" },
    });
  });
});
