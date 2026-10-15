import { describe, expect, it } from "vitest";
import {
  MemoryTransport,
  Shadow,
  accumulateChatChunks,
  openAITokenUsage,
  runOpenAIToolLoop,
  traceOpenAI,
  type IngestEventInput,
  type OpenAIChatCompletionLike,
  type OpenAIResponseLike,
} from "../src/index.js";

interface ChatParams {
  model: string;
  messages: { role: string; content?: unknown; tool_calls?: unknown; tool_call_id?: string }[];
  tools?: { type: "function"; function: { name: string; parameters?: unknown } }[];
  stream?: boolean;
  temperature?: number;
  max_completion_tokens?: number;
}

interface ResponsesParams {
  model: string;
  input: unknown;
  instructions?: string;
  tools?: { type: string; name?: string }[];
  stream?: boolean;
  reasoning?: { effort: string };
}

async function* chunks<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

/** A stand-in for the OpenAI client: classes with private state, like the real SDK. */
class FakeCompletions {
  readonly seen: ChatParams[] = [];
  #queue: (OpenAIChatCompletionLike | unknown[] | Error)[];
  constructor(queue: (OpenAIChatCompletionLike | unknown[] | Error)[]) {
    this.#queue = queue;
  }
  async create(params: ChatParams): Promise<unknown> {
    this.seen.push({ ...params, messages: [...params.messages] });
    const next = this.#queue.shift();
    if (!next) throw new Error("no more canned responses");
    if (next instanceof Error) throw next;
    return Array.isArray(next) ? chunks(next) : next;
  }
}

class FakeResponses {
  readonly seen: ResponsesParams[] = [];
  #queue: (OpenAIResponseLike | unknown[] | Error)[];
  constructor(queue: (OpenAIResponseLike | unknown[] | Error)[]) {
    this.#queue = queue;
  }
  async create(params: ResponsesParams): Promise<unknown> {
    this.seen.push(params);
    const next = this.#queue.shift();
    if (!next) throw new Error("no more canned responses");
    if (next instanceof Error) throw next;
    return Array.isArray(next) ? chunks(next) : next;
  }
  async retrieve(id: string): Promise<{ id: string }> {
    return { id };
  }
}

class FakeClient {
  readonly chat: { completions: FakeCompletions };
  readonly responses: FakeResponses;
  readonly beta: { chat: { completions: FakeCompletions } };
  #name = "fake";
  constructor(
    chat: (OpenAIChatCompletionLike | unknown[] | Error)[],
    responses: (OpenAIResponseLike | unknown[] | Error)[] = [],
  ) {
    this.chat = { completions: new FakeCompletions(chat) };
    this.responses = new FakeResponses(responses);
    this.beta = { chat: { completions: new FakeCompletions([]) } };
  }
  describe(): string {
    return this.#name;
  }
}

const completion = (
  content: string | null,
  extra: Partial<OpenAIChatCompletionLike["choices"][number]> = {},
  usage: OpenAIChatCompletionLike["usage"] = {
    prompt_tokens: 12,
    completion_tokens: 6,
    total_tokens: 18,
  },
): OpenAIChatCompletionLike => ({
  id: "chatcmpl_1",
  model: "gpt-5",
  choices: [{ message: { role: "assistant", content }, finish_reason: "stop", ...extra }],
  usage,
});

function setup() {
  const transport = new MemoryTransport();
  const trace = new Shadow({
    project: "support",
    agent: "gpt-agent",
    transport,
    flushIntervalMs: 0,
  }).startTrace({ name: "openai" });
  const events = async (): Promise<IngestEventInput[]> => {
    await trace.flush();
    return transport.eventsFor(trace.traceId);
  };
  return { trace, events };
}

const named = (list: IngestEventInput[], type: string) => list.filter((e) => e.eventType === type);

/** The loop wants a typed `create`; the fake returns `unknown` so it can also stream. */
type LoopClient = {
  chat: { completions: { create(params: ChatParams): Promise<OpenAIChatCompletionLike> } };
};
const asLoopClient = (client: FakeClient): LoopClient => client as unknown as LoopClient;

describe("openAITokenUsage", () => {
  it("reads chat and responses usage, with cached tokens inside the prompt", () => {
    expect(
      openAITokenUsage({
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_tokens_details: { cached_tokens: 60 },
      }),
    ).toEqual({ inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedInputTokens: 60 });
    expect(openAITokenUsage({ input_tokens: 7, output_tokens: 3 })).toEqual({
      inputTokens: 7,
      outputTokens: 3,
      totalTokens: 10,
    });
    expect(openAITokenUsage(null)).toBeUndefined();
    expect(openAITokenUsage({})).toBeUndefined();
  });
});

describe("accumulateChatChunks", () => {
  it("folds content, tool call fragments, the finish reason and usage", () => {
    const folded = accumulateChatChunks([
      {
        id: "c1",
        model: "gpt-5",
        choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }],
      },
      { choices: [{ index: 0, delta: { content: "lo" } }] },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "look", arguments: '{"id":' },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] } },
        ],
      },
      { choices: [{ index: 1, delta: { content: "ignored second choice" } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      { choices: [], usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 } },
    ]);
    expect(folded).toEqual({
      id: "c1",
      model: "gpt-5",
      choices: [
        {
          message: {
            role: "assistant",
            content: "Hello",
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "look", arguments: '{"id":1}' } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
    });
  });
});

describe("traceOpenAI", () => {
  it("records chat completions as model spans with context, tool calls and usage", async () => {
    const { trace, events } = setup();
    const raw = new FakeClient([
      completion(null, {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "lookup_order", arguments: '{"orderId":"ord_1"}' },
            },
          ],
        },
        finish_reason: "tool_calls",
      }),
      completion(
        "Refund issued.",
        {},
        {
          prompt_tokens: 40,
          completion_tokens: 8,
          total_tokens: 48,
          prompt_tokens_details: { cached_tokens: 30 },
        },
      ),
    ]);
    const client = traceOpenAI(trace, raw);
    expect(client.describe()).toBe("fake");
    const history: ChatParams["messages"] = [
      { role: "system", content: "You are a refund agent." },
      { role: "user", content: "Refund order ord_1" },
    ];
    const tools: ChatParams["tools"] = [{ type: "function", function: { name: "lookup_order" } }];
    const first = (await client.chat.completions.create({
      model: "gpt-5",
      messages: history,
      tools,
      temperature: 0,
    })) as OpenAIChatCompletionLike;
    expect(first.choices[0]?.finish_reason).toBe("tool_calls");
    history.push({
      role: "assistant",
      content: null,
      tool_calls: first.choices[0]?.message?.tool_calls,
    });
    history.push({ role: "tool", tool_call_id: "call_1", content: '{"status":"shipped"}' });
    await client.chat.completions.create({ model: "gpt-5", messages: history, tools });

    const list = await events();
    expect(
      named(list, "context.added").map((e) => [e.name, (e.output as { value: unknown }).value]),
    ).toEqual([
      ["system", "You are a refund agent."],
      ["tools", ["lookup_order"]],
    ]);
    const requests = named(list, "model.request");
    expect(requests.map((e) => e.name)).toEqual(["turn-1", "turn-2"]);
    expect(requests[0]).toMatchObject({
      input: {
        provider: "openai",
        model: "gpt-5",
        messages: [
          { role: "system", content: "You are a refund agent." },
          { role: "user", content: "Refund order ord_1" },
        ],
        parameters: { temperature: 0, tools: ["lookup_order"] },
      },
      metadata: { openai: { api: "chat.completions", historyLength: 2, skippedMessages: 0 } },
    });
    // The second call only records what was appended to the same history array.
    expect(requests[1]?.input).toMatchObject({
      messages: [
        { role: "assistant", content: { content: null, tool_calls: [{ id: "call_1" }] } },
        { role: "tool", content: { tool_call_id: "call_1", content: '{"status":"shipped"}' } },
      ],
    });
    expect(requests[1]?.metadata).toMatchObject({
      openai: { historyLength: 4, skippedMessages: 2 },
    });
    const responses = named(list, "model.response");
    expect(responses[0]?.output).toMatchObject({
      finishReason: "tool_calls",
      toolCalls: [{ tool: "lookup_order", arguments: { orderId: "ord_1" }, id: "call_1" }],
    });
    expect(responses[0]?.tokenUsage).toEqual({ inputTokens: 12, outputTokens: 6, totalTokens: 18 });
    expect(responses[1]?.output).toMatchObject({
      message: { role: "assistant", content: { role: "assistant", content: "Refund issued." } },
      finishReason: "stop",
    });
    expect(responses[1]?.tokenUsage).toEqual({
      inputTokens: 40,
      outputTokens: 8,
      totalTokens: 48,
      cachedInputTokens: 30,
    });
  });

  it("records streamed chat completions once the stream is consumed", async () => {
    const { trace, events } = setup();
    const raw = new FakeClient([
      [
        {
          id: "c9",
          model: "gpt-5",
          choices: [{ index: 0, delta: { role: "assistant", content: "Par" } }],
        },
        { choices: [{ index: 0, delta: { content: "tial" }, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
      ],
    ]);
    const client = traceOpenAI(trace, raw);
    const stream = (await client.chat.completions.create({
      model: "gpt-5",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    })) as AsyncIterable<{ choices: { delta: { content?: string } }[] }>;
    let text = "";
    for await (const chunk of stream) text += chunk.choices[0]?.delta.content ?? "";
    expect(text).toBe("Partial");
    const list = await events();
    expect(named(list, "model.request")).toHaveLength(1);
    const response = named(list, "model.response")[0];
    expect(response?.output).toMatchObject({
      message: { content: { role: "assistant", content: "Partial" } },
      finishReason: "stop",
    });
    expect(response?.tokenUsage).toEqual({ inputTokens: 3, outputTokens: 2, totalTokens: 5 });
  });

  it("records the Responses API, streamed or not, with reasoning notes and tool calls", async () => {
    const { trace, events } = setup();
    const final: OpenAIResponseLike = {
      id: "resp_1",
      model: "gpt-5",
      status: "completed",
      output: [
        { type: "reasoning", summary: [{ type: "summary_text", text: "Check the order first." }] },
        {
          type: "function_call",
          call_id: "call_7",
          name: "lookup_order",
          arguments: '{"orderId":"ord_1"}',
        },
      ],
      usage: {
        input_tokens: 50,
        output_tokens: 12,
        total_tokens: 62,
        input_tokens_details: { cached_tokens: 20 },
      },
    };
    const streamed: OpenAIResponseLike = {
      id: "resp_2",
      model: "gpt-5",
      status: "completed",
      output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] },
      ],
      output_text: "Done.",
      usage: { input_tokens: 9, output_tokens: 2, total_tokens: 11 },
    };
    const raw = new FakeClient(
      [],
      [
        final,
        [
          { type: "response.created", response: { id: "resp_2", output: [] } },
          { type: "response.output_text.delta", delta: "Done." },
          { type: "response.completed", response: streamed },
        ],
      ],
    );
    const client = traceOpenAI(trace, raw, { name: (_p, call) => `step-${call}` });
    const input: unknown[] = [{ role: "user", content: "Refund order ord_1" }];
    const response = (await client.responses.create({
      model: "gpt-5",
      instructions: "Be brief.",
      input,
      tools: [{ type: "function", name: "lookup_order" }, { type: "web_search" }],
      reasoning: { effort: "low" },
    })) as OpenAIResponseLike;
    expect(response.id).toBe("resp_1");
    input.push({ type: "function_call_output", call_id: "call_7", output: '{"status":"shipped"}' });
    const stream = (await client.responses.create({
      model: "gpt-5",
      instructions: "Be brief.",
      input,
      stream: true,
    })) as AsyncIterable<{ type: string }>;
    const types: string[] = [];
    for await (const event of stream) types.push(event.type);
    expect(types).toEqual(["response.created", "response.output_text.delta", "response.completed"]);
    expect((await client.responses.retrieve("resp_1")).id).toBe("resp_1");

    const list = await events();
    expect(
      named(list, "context.added").map((e) => [e.name, (e.output as { value: unknown }).value]),
    ).toEqual([
      ["system", "Be brief."],
      ["tools", ["lookup_order", "web_search"]],
    ]);
    const requests = named(list, "model.request");
    expect(requests.map((e) => e.name)).toEqual(["step-1", "step-2"]);
    expect(requests[0]?.input).toMatchObject({
      provider: "openai",
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: { role: "user", content: "Refund order ord_1" } },
      ],
      parameters: { reasoning: { effort: "low" }, tools: ["lookup_order", "web_search"] },
    });
    expect(requests[0]?.metadata).toMatchObject({ openai: { api: "responses", historyLength: 1 } });
    expect(requests[1]?.input).toMatchObject({
      messages: [{ role: "user", content: { type: "function_call_output", call_id: "call_7" } }],
    });
    const responses = named(list, "model.response");
    expect(responses[0]?.output).toMatchObject({
      finishReason: "tool_calls",
      toolCalls: [{ tool: "lookup_order", arguments: { orderId: "ord_1" }, id: "call_7" }],
    });
    expect(responses[0]?.tokenUsage).toEqual({
      inputTokens: 50,
      outputTokens: 12,
      totalTokens: 62,
      cachedInputTokens: 20,
    });
    expect(responses[1]?.output).toMatchObject({ finishReason: "completed" });
    expect(responses[1]?.tokenUsage).toEqual({ inputTokens: 9, outputTokens: 2, totalTokens: 11 });
    expect(named(list, "agent.note").map((e) => [e.name, e.output])).toEqual([
      ["reasoning", { text: "Check the order first." }],
    ]);
  });

  it("notes failed requests and re-throws them", async () => {
    const { trace, events } = setup();
    const raw = new FakeClient([Object.assign(new Error("rate limited"), { status: 429 })]);
    const client = traceOpenAI(trace, raw);
    await expect(
      client.chat.completions.create({
        model: "gpt-5",
        messages: [{ role: "user", content: "x" }],
      }),
    ).rejects.toThrow("rate limited");
    const list = await events();
    expect(named(list, "model.request")).toHaveLength(1);
    expect(named(list, "model.response")).toHaveLength(0);
    expect(named(list, "agent.note")[0]).toMatchObject({
      name: "openai.request_failed",
      output: { message: "rate limited", status: 429 },
    });
  });
});

describe("runOpenAIToolLoop", () => {
  const call = (id: string, name: string, args: string) => ({
    id,
    type: "function",
    function: { name, arguments: args },
  });

  it("runs tools as spans, answers each call with a tool message and stops at stop", async () => {
    const { trace, events } = setup();
    const raw = new FakeClient([
      completion(null, {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            call("call_1", "lookup_order", '{"orderId":"ord_1"}'),
            call("call_2", "explode", "{}"),
            call("call_3", "missing", "not json"),
          ],
        },
        finish_reason: "tool_calls",
      }),
      completion("All done."),
    ]);
    const client = traceOpenAI(trace, raw);
    const result = await runOpenAIToolLoop(trace, asLoopClient(client), {
      params: {
        model: "gpt-5",
        messages: [{ role: "user", content: "Refund order ord_1" }],
        tools: [{ type: "function", function: { name: "lookup_order" } }],
      },
      tools: {
        lookup_order: (input) => ({ status: "shipped", input }),
        explode: () => {
          throw new Error("boom");
        },
      },
    });
    expect(result.turns).toBe(2);
    expect(result.stopReason).toBe("stop");
    expect(result.completion.choices[0]?.message?.content).toBe("All done.");
    expect(result.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "tool",
      "tool",
      "assistant",
    ]);
    expect(result.messages[2]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: JSON.stringify({ status: "shipped", input: { orderId: "ord_1" } }),
    });
    expect(result.messages[3]).toEqual({
      role: "tool",
      tool_call_id: "call_2",
      content: JSON.stringify({ error: "boom" }),
    });
    expect(result.messages[4]).toEqual({
      role: "tool",
      tool_call_id: "call_3",
      content: JSON.stringify({ error: "no implementation for tool 'missing'" }),
    });
    // The second request carried the tool results; the starting history was not mutated.
    expect(raw.chat.completions.seen[1]?.messages).toHaveLength(5);
    expect(raw.chat.completions.seen[0]?.messages).toHaveLength(1);

    const list = await events();
    expect(named(list, "model.request")).toHaveLength(2);
    expect(named(list, "tool.request").map((e) => e.name)).toEqual([
      "lookup_order",
      "explode",
      "missing",
    ]);
    expect(named(list, "tool.request")[0]).toMatchObject({
      input: { tool: "lookup_order", arguments: { orderId: "ord_1" } },
      metadata: { openai: { toolCallId: "call_1" } },
    });
    expect(named(list, "tool.request")[2]?.input).toMatchObject({ arguments: "not json" });
    expect(named(list, "tool.response")).toHaveLength(1);
    expect(
      named(list, "tool.error").map(
        (e) => (e.output as { error: { message: string } }).error.message,
      ),
    ).toEqual(["boom", "no implementation for tool 'missing'"]);
  });

  it("blocks guarded tools and respects maxTurns", async () => {
    const { trace, events } = setup();
    const asking = () =>
      completion(null, {
        message: { role: "assistant", content: null, tool_calls: [call("c", "delete_all", "{}")] },
        finish_reason: "tool_calls",
      });
    const raw = new FakeClient([asking(), asking(), asking()]);
    const client = traceOpenAI(trace, raw);
    const ran: string[] = [];
    const result = await runOpenAIToolLoop(trace, asLoopClient(client), {
      params: { model: "gpt-5", messages: [{ role: "user", content: "wipe it" }] },
      tools: {
        delete_all: () => {
          ran.push("delete_all");
          return "done";
        },
      },
      guard: (tool) => ({
        policy: "ops.destructive",
        subject: { tool },
        evaluate: () => ({ decision: "deny" }),
      }),
      maxTurns: 2,
    });
    expect(ran).toEqual([]);
    expect(result.turns).toBe(2);
    expect(result.stopReason).toBe("max_turns");
    expect(result.messages.filter((m) => m.role === "tool")).toHaveLength(2);
    expect(String(result.messages[2]?.content)).toContain("blocked");
    const list = await events();
    expect(named(list, "policy.evaluated")).toHaveLength(2);
    expect(named(list, "tool.error")).toHaveLength(2);
  });
});
