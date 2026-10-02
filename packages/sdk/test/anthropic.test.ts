import { describe, expect, it } from "vitest";
import {
  MemoryTransport,
  Shadow,
  anthropicTokenUsage,
  runAnthropicToolLoop,
  traceAnthropic,
  type AnthropicMessageLike,
  type IngestEventInput,
} from "../src/index.js";

interface Params {
  model: string;
  max_tokens: number;
  messages: { role: string; content: unknown }[];
  system?: string;
  tools?: { name: string; input_schema?: unknown }[];
  stream?: boolean;
  thinking?: { type: string };
}

interface Message extends AnthropicMessageLike {
  id: string;
  content: { type: string; [key: string]: unknown }[];
}

/** A stand-in for the Anthropic client: classes with private state, like the real SDK. */
class FakeMessages {
  #queue: (Message | Error)[];
  readonly seen: Params[] = [];
  constructor(queue: (Message | Error)[]) {
    this.#queue = queue;
  }
  async create(params: Params): Promise<Message> {
    this.seen.push({ ...params, messages: [...params.messages] });
    const next = this.#queue.shift();
    if (!next) throw new Error("no more canned responses");
    if (next instanceof Error) throw next;
    return next;
  }
  stream(params: Params) {
    const final = this.create(params);
    return { finalMessage: () => final, on: () => undefined };
  }
}

class FakeClient {
  readonly messages: FakeMessages;
  readonly beta: { messages: FakeMessages };
  #name = "fake";
  constructor(queue: (Message | Error)[], betaQueue: (Message | Error)[] = []) {
    this.messages = new FakeMessages(queue);
    this.beta = { messages: new FakeMessages(betaQueue) };
  }
  describe(): string {
    return this.#name;
  }
}

const text = (id: string, value: string, extra: Partial<Message> = {}): Message => ({
  id,
  model: "claude-opus-5-5",
  content: [{ type: "text", text: value }],
  stop_reason: "end_turn",
  usage: { input_tokens: 10, output_tokens: 5 },
  ...extra,
});

const toolUse = (id: string, calls: { id: string; name: string; input: unknown }[]): Message => ({
  id,
  model: "claude-opus-5-5",
  content: calls.map((c) => ({ type: "tool_use", ...c })),
  stop_reason: "tool_use",
  usage: { input_tokens: 20, output_tokens: 8 },
});

function setup() {
  const transport = new MemoryTransport();
  const shadow = new Shadow({
    project: "support",
    agent: "claude-agent",
    transport,
    flushIntervalMs: 0,
  });
  const trace = shadow.startTrace({ name: "anthropic" });
  const events = async (): Promise<IngestEventInput[]> => {
    await trace.flush();
    return transport.eventsFor(trace.traceId);
  };
  return { trace, events };
}

const named = (list: IngestEventInput[], type: string) => list.filter((e) => e.eventType === type);

describe("anthropicTokenUsage", () => {
  it("counts cache reads and writes as part of the prompt", () => {
    expect(
      anthropicTokenUsage({
        input_tokens: 96,
        output_tokens: 74,
        cache_read_input_tokens: 412,
        cache_creation_input_tokens: 120,
      }),
    ).toEqual({ inputTokens: 628, outputTokens: 74, totalTokens: 702, cachedInputTokens: 412 });
    expect(
      anthropicTokenUsage({ input_tokens: 5, output_tokens: 1, cache_read_input_tokens: null }),
    ).toEqual({
      inputTokens: 5,
      outputTokens: 1,
      totalTokens: 6,
    });
    expect(anthropicTokenUsage(undefined)).toBeUndefined();
    expect(anthropicTokenUsage({})).toBeUndefined();
  });
});

describe("traceAnthropic", () => {
  it("records messages.create as model spans and passes everything else through", async () => {
    const { trace, events } = setup();
    const raw = new FakeClient([
      {
        id: "msg_1",
        model: "claude-opus-5-5",
        content: [
          { type: "thinking", thinking: "check the order first", signature: "s" },
          { type: "redacted_thinking", data: "x" },
          { type: "tool_use", id: "toolu_1", name: "lookup_order", input: { orderId: "ord_1" } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50 },
      },
      text("msg_2", "Refund issued."),
    ]);
    const client = traceAnthropic(trace, raw);
    // The wrapper keeps the client's own type and private state working.
    expect(client.describe()).toBe("fake");

    const history: Params["messages"] = [{ role: "user", content: "refund ord_1" }];
    const base = {
      model: "claude-opus-5-5",
      max_tokens: 16000,
      system: "You are a support agent.",
      tools: [{ name: "lookup_order", input_schema: { type: "object" } }],
      thinking: { type: "adaptive" },
    };
    const first = await client.messages.create({ ...base, messages: history });
    expect(first.id).toBe("msg_1");
    history.push({ role: "assistant", content: first.content });
    history.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "{}" }],
    });
    const second = await client.messages.create({ ...base, messages: history });
    expect(second.stop_reason).toBe("end_turn");
    // The underlying client received the caller's parameters unchanged.
    expect(raw.messages.seen[1]?.messages).toHaveLength(3);

    const list = await events();
    const [req1, req2] = named(list, "model.request");
    expect(req1).toMatchObject({
      name: "turn-1",
      input: {
        provider: "anthropic",
        model: "claude-opus-5-5",
        messages: [
          { role: "system", content: "You are a support agent." },
          { role: "user", content: "refund ord_1" },
        ],
        parameters: { max_tokens: 16000, thinking: { type: "adaptive" }, tools: ["lookup_order"] },
      },
      metadata: { anthropic: { historyLength: 1, skippedMessages: 0 } },
    });
    // The history was extended in place, so the second request records only the new turns.
    expect(req2).toMatchObject({
      name: "turn-2",
      metadata: { anthropic: { historyLength: 3, skippedMessages: 1 } },
    });
    expect((req2?.input as { messages: { role: string }[] }).messages.map((m) => m.role)).toEqual([
      "assistant",
      "user",
    ]);

    const [res1, res2] = named(list, "model.response");
    expect(res1).toMatchObject({
      parentEventId: req1?.id,
      output: {
        finishReason: "tool_use",
        toolCalls: [{ tool: "lookup_order", arguments: { orderId: "ord_1" }, id: "toolu_1" }],
      },
      tokenUsage: { inputTokens: 150, outputTokens: 20, totalTokens: 170, cachedInputTokens: 50 },
    });
    expect(res2?.output).toMatchObject({ finishReason: "end_turn" });
    expect(res2?.estimatedCost ?? null).toBeNull();

    expect(named(list, "agent.note").map((e) => [e.name, e.output])).toEqual([
      ["thinking", { text: "check the order first" }],
      ["thinking", { redacted: true }],
    ]);
    expect(named(list, "context.added").map((e) => e.name)).toEqual(["system", "tools"]);
  });

  it("records the full history when asked or when the array was replaced", async () => {
    const all = setup();
    const client = traceAnthropic(
      all.trace,
      new FakeClient([text("a", "one"), text("b", "two"), text("c", "three")]),
      { recordMessages: "all", name: (_params, call) => `step ${call}`, notes: false },
    );
    const history = [{ role: "user", content: "hi" }];
    await client.messages.create({ model: "claude-opus-5-5", max_tokens: 100, messages: history });
    history.push({ role: "assistant", content: "one" }, { role: "user", content: "more" });
    await client.messages.create({ model: "claude-opus-5-5", max_tokens: 100, messages: history });
    const requests = named(await all.events(), "model.request");
    expect(requests.map((r) => r.name)).toEqual(["step 1", "step 2"]);
    expect((requests[1]?.input as { messages: unknown[] }).messages).toHaveLength(3);

    const replaced = setup();
    const other = traceAnthropic(
      replaced.trace,
      new FakeClient([text("a", "one"), text("b", "two")]),
    );
    await other.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
    });
    // A fresh array with a different first message is not an extension of the previous history.
    await other.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 100,
      messages: [
        { role: "user", content: "compacted summary" },
        { role: "user", content: "next" },
      ],
    });
    const second = named(await replaced.events(), "model.request")[1];
    expect(second?.metadata).toEqual({ anthropic: { historyLength: 2, skippedMessages: 0 } });
  });

  it("records streams from their final message and beta.messages calls", async () => {
    const { trace, events } = setup();
    const client = traceAnthropic(
      trace,
      new FakeClient([text("msg_s", "streamed")], [text("msg_b", "beta")]),
    );
    const stream = client.messages.stream({
      model: "claude-opus-5-5",
      max_tokens: 64000,
      messages: [{ role: "user", content: "stream please" }],
    });
    expect((await stream.finalMessage()).id).toBe("msg_s");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 100,
      messages: [{ role: "user", content: "beta" }],
    });
    const list = await events();
    expect(
      named(list, "model.response").map(
        (e) => (e.output as { message: { content: unknown } }).message.content,
      ),
    ).toEqual([[{ type: "text", text: "streamed" }], [{ type: "text", text: "beta" }]]);
    expect(named(list, "model.request").map((e) => e.name)).toEqual(["turn-1", "turn-2"]);
  });

  it("passes raw event streams through unrecorded and notes failed requests", async () => {
    const { trace, events } = setup();
    const failure = Object.assign(new Error("overloaded"), { status: 529 });
    const raw = new FakeClient([text("msg_raw", "raw"), failure, new Error("stream broke")]);
    const client = traceAnthropic(trace, raw);
    const passthrough = await client.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 100,
      stream: true,
      messages: [{ role: "user", content: "raw stream" }],
    });
    expect(passthrough.id).toBe("msg_raw");
    await expect(
      client.messages.create({
        model: "claude-opus-5-5",
        max_tokens: 100,
        messages: [{ role: "user", content: "fail" }],
      }),
    ).rejects.toThrow("overloaded");
    // A failing stream is noted too, without an unhandled rejection from the recorder.
    const stream = client.messages.stream({
      model: "claude-opus-5-5",
      max_tokens: 100,
      messages: [{ role: "user", content: "fail again" }],
    });
    await expect(stream.finalMessage()).rejects.toThrow("stream broke");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const list = await events();
    expect(named(list, "model.request")).toHaveLength(2);
    expect(named(list, "model.response")).toHaveLength(0);
    expect(named(list, "agent.note").map((e) => [e.name, e.output])).toEqual([
      ["anthropic.request_failed", { message: "overloaded", name: "Error", status: 529 }],
      ["anthropic.request_failed", { message: "stream broke", name: "Error" }],
    ]);
  });
});

describe("runAnthropicToolLoop", () => {
  const params = {
    model: "claude-opus-5-5",
    max_tokens: 16000,
    messages: [{ role: "user", content: "refund ord_1" }],
    tools: [{ name: "lookup_order" }, { name: "refund_order" }],
  };

  it("runs tools as spans, returns every result in one user message and stops at end_turn", async () => {
    const { trace, events } = setup();
    const raw = new FakeClient([
      toolUse("m1", [
        { id: "toolu_a", name: "lookup_order", input: { orderId: "ord_1" } },
        { id: "toolu_b", name: "refund_order", input: { orderId: "ord_1", amount: 480 } },
        { id: "toolu_c", name: "not_registered", input: {} },
        { id: "toolu_d", name: "explode", input: {} },
      ]),
      text("m2", "I've asked a colleague to approve the refund."),
    ]);
    const client = traceAnthropic(trace, raw);
    const result = await runAnthropicToolLoop(trace, client, {
      params,
      tools: {
        lookup_order: (input) => ({ id: (input as { orderId: string }).orderId, amount: 480 }),
        refund_order: () => "refunded",
        explode: () => {
          throw new Error("boom");
        },
      },
      guard: (tool, input) =>
        tool === "refund_order"
          ? {
              policy: "refund.autonomous_limit",
              subject: input,
              evaluate: () => ({ decision: "approval_required", reason: "over the limit" }),
            }
          : undefined,
    });

    expect(result.turns).toBe(2);
    expect(result.stopReason).toBe("end_turn");
    expect(result.message.id).toBe("m2");
    expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    // The caller's starting history is not mutated.
    expect(params.messages).toHaveLength(1);
    expect(result.messages[2]?.content).toEqual([
      { type: "tool_result", tool_use_id: "toolu_a", content: '{"id":"ord_1","amount":480}' },
      {
        type: "tool_result",
        tool_use_id: "toolu_b",
        is_error: true,
        content: expect.stringContaining("refund.autonomous_limit"),
      },
      {
        type: "tool_result",
        tool_use_id: "toolu_c",
        is_error: true,
        content: "no implementation for tool 'not_registered'",
      },
      { type: "tool_result", tool_use_id: "toolu_d", is_error: true, content: "boom" },
    ]);
    // The second request carried the assistant turn and the tool results.
    expect(raw.messages.seen[1]?.messages).toHaveLength(3);

    const list = await events();
    expect(named(list, "tool.request").map((e) => [e.name, e.metadata])).toEqual([
      ["lookup_order", { anthropic: { toolUseId: "toolu_a" } }],
      ["refund_order", { anthropic: { toolUseId: "toolu_b" } }],
      ["not_registered", { anthropic: { toolUseId: "toolu_c" } }],
      ["explode", { anthropic: { toolUseId: "toolu_d" } }],
    ]);
    expect(named(list, "tool.response").map((e) => e.name)).toEqual(["lookup_order"]);
    expect(named(list, "tool.error").map((e) => e.name)).toEqual([
      "refund_order",
      "not_registered",
      "explode",
    ]);
    expect(named(list, "policy.evaluated")).toHaveLength(1);
    expect(named(list, "model.request")).toHaveLength(2);
  });

  it("continues paused turns, stops on refusals and respects maxTurns", async () => {
    const paused = setup();
    const pausedClient = traceAnthropic(
      paused.trace,
      new FakeClient([text("p1", "searching", { stop_reason: "pause_turn" }), text("p2", "done")]),
    );
    const continued = await runAnthropicToolLoop(paused.trace, pausedClient, { params, tools: {} });
    expect(continued).toMatchObject({ turns: 2, stopReason: "end_turn" });
    expect(continued.messages.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);

    const refused = setup();
    let ran = false;
    const refusal = await runAnthropicToolLoop(
      refused.trace,
      traceAnthropic(
        refused.trace,
        new FakeClient([
          {
            id: "r1",
            content: [{ type: "tool_use", id: "toolu_x", name: "lookup_order", input: {} }],
            stop_reason: "refusal",
          },
        ]),
      ),
      {
        params,
        tools: {
          lookup_order: () => {
            ran = true;
            return null;
          },
        },
      },
    );
    expect(refusal).toMatchObject({ turns: 1, stopReason: "refusal" });
    expect(ran).toBe(false);

    const capped = setup();
    const looping = await runAnthropicToolLoop(
      capped.trace,
      traceAnthropic(
        capped.trace,
        new FakeClient([
          toolUse("l1", [{ id: "toolu_1", name: "lookup_order", input: {} }]),
          toolUse("l2", [{ id: "toolu_2", name: "lookup_order", input: {} }]),
          toolUse("l3", [{ id: "toolu_3", name: "lookup_order", input: {} }]),
        ]),
      ),
      { params, tools: { lookup_order: () => "ok" }, maxTurns: 2 },
    );
    expect(looping).toMatchObject({ turns: 2, stopReason: "max_turns" });
    expect(looping.messages).toHaveLength(5);
  });
});
