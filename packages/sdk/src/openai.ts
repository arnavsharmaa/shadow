import type { JsonObject, JsonValue, ModelResult, PolicyCall, TokenUsage } from "@shadow/schemas";
import { toJson } from "./pointer.js";
import type { Trace } from "./trace.js";

/**
 * Recording for agents built directly on the OpenAI API.
 *
 * `traceOpenAI(trace, client)` returns the same client with `chat.completions.create` and
 * `responses.create` recorded as model spans, streamed or not; everything else passes through.
 * The client is matched structurally, so there is no dependency on the `openai` package and the
 * caller keeps the SDK's own types.
 */

type Fn = (...args: unknown[]) => unknown;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

/** The part of a chat completion this adapter reads. */
export interface OpenAIChatCompletionLike {
  id?: string;
  model?: string;
  choices: readonly {
    message?: {
      role?: string;
      content?: unknown;
      refusal?: unknown;
      tool_calls?: readonly {
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number | null } | null;
  } | null;
}

/** The part of chat completion parameters this adapter reads. */
export interface OpenAIChatParamsLike {
  model: string;
  messages: readonly { role: string; content?: unknown }[];
  tools?: readonly { type?: string; function?: { name?: string } }[];
  stream?: boolean;
}

/** The part of a Responses API response this adapter reads. */
export interface OpenAIResponseLike {
  id?: string;
  model?: string;
  status?: string;
  output?: readonly { type: string; [key: string]: unknown }[];
  output_text?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    input_tokens_details?: { cached_tokens?: number | null } | null;
  } | null;
}

/** The part of Responses API parameters this adapter reads. */
export interface OpenAIResponsesParamsLike {
  model: string;
  input: unknown;
  instructions?: unknown;
  tools?: readonly { type?: string; name?: string }[];
  stream?: boolean;
}

export interface TraceOpenAIOptions {
  /** Step name for each call (default `turn-N`, counting recorded calls). */
  name?: (params: OpenAIChatParamsLike | OpenAIResponsesParamsLike, call: number) => string;
  /**
   * `"new"` (default) records only the messages (or input items) added since the previous
   * recorded call when the history was extended in place; `"all"` records everything each time.
   */
  recordMessages?: "new" | "all";
  /** Record reasoning summaries from the Responses API as `reasoning` notes (default true). */
  notes?: boolean;
}

const CHAT_PARAMETER_KEYS = [
  "max_tokens",
  "max_completion_tokens",
  "temperature",
  "top_p",
  "n",
  "stop",
  "presence_penalty",
  "frequency_penalty",
  "tool_choice",
  "parallel_tool_calls",
  "response_format",
  "reasoning_effort",
  "seed",
  "service_tier",
  "metadata",
] as const;

const RESPONSES_PARAMETER_KEYS = [
  "max_output_tokens",
  "temperature",
  "top_p",
  "tool_choice",
  "parallel_tool_calls",
  "reasoning",
  "text",
  "truncation",
  "previous_response_id",
  "store",
  "service_tier",
  "metadata",
] as const;

/**
 * Token usage in Shadow's convention. OpenAI counts cached prompt tokens inside `prompt_tokens`
 * (and `input_tokens`), so `inputTokens` is taken as is and `cachedInputTokens` is the cached
 * part of it.
 */
export function openAITokenUsage(
  usage: OpenAIChatCompletionLike["usage"] | OpenAIResponseLike["usage"],
): TokenUsage | undefined {
  if (!usage) return undefined;
  const u = usage as Record<string, unknown>;
  const num = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const input = num(u.prompt_tokens) ?? num(u.input_tokens);
  const output = num(u.completion_tokens) ?? num(u.output_tokens);
  if (input === undefined && output === undefined) return undefined;
  const details = (u.prompt_tokens_details ?? u.input_tokens_details) as
    { cached_tokens?: number | null } | null | undefined;
  const cached = num(details?.cached_tokens) ?? 0;
  return {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    totalTokens: num(u.total_tokens) ?? (input ?? 0) + (output ?? 0),
    ...(cached > 0 ? { cachedInputTokens: cached } : {}),
  };
}

/** Tool arguments arrive as a JSON string; keep them structured when they parse. */
function parseArguments(text: unknown): JsonValue {
  if (typeof text !== "string") return toJson(text ?? null);
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return text;
  }
}

function chatResult(completion: OpenAIChatCompletionLike): ModelResult {
  const choice = completion.choices[0];
  const message = choice?.message ?? {};
  const toolCalls = (message.tool_calls ?? []).map((call) => ({
    tool: call.function?.name ?? "unknown",
    arguments: parseArguments(call.function?.arguments),
    ...(typeof call.id === "string" ? { id: call.id } : {}),
  }));
  return {
    message: { role: "assistant", content: toJson(message) },
    ...(choice?.finish_reason ? { finishReason: choice.finish_reason } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    tokenUsage: openAITokenUsage(completion.usage),
  };
}

function responsesResult(response: OpenAIResponseLike): ModelResult {
  const output = response.output ?? [];
  const toolCalls = output
    .filter((item) => item.type === "function_call")
    .map((item) => ({
      tool: typeof item.name === "string" ? item.name : "unknown",
      arguments: parseArguments(item.arguments),
      ...(typeof item.call_id === "string" ? { id: item.call_id } : {}),
    }));
  const finish =
    toolCalls.length > 0 && (response.status === undefined || response.status === "completed")
      ? "tool_calls"
      : response.status;
  return {
    message: { role: "assistant", content: toJson(output) },
    ...(finish ? { finishReason: finish } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    tokenUsage: openAITokenUsage(response.usage),
  };
}

interface WrapState {
  calls: number;
  previous: readonly unknown[];
  system: string | undefined;
  tools: string | undefined;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => isObject(b) && typeof b.text === "string")
    .map((b) => String((b as { text: string }).text))
    .join("\n");
}

function recordContext(
  trace: Trace,
  state: WrapState,
  system: string | undefined,
  tools: string[],
): void {
  if (system !== undefined && system !== state.system) {
    state.system = system;
    trace.context.set("system", system);
  }
  const key = tools.join("\u0000");
  if (tools.length > 0 && key !== state.tools) {
    state.tools = key;
    trace.context.set("tools", tools);
  }
}

type Role = "system" | "user" | "assistant" | "tool";
const role = (value: unknown): Role =>
  value === "assistant" || value === "tool"
    ? value
    : value === "system" || value === "developer"
      ? "system"
      : "user";

/** Items to record for this call, and how many earlier ones were left out. */
function itemsFor(
  all: readonly unknown[],
  state: WrapState,
  mode: "new" | "all",
  toMessage: (item: unknown) => { role: Role; content: JsonValue },
): { messages: { role: Role; content: JsonValue }[]; skipped: number } {
  const extended =
    mode === "new" &&
    state.previous.length > 0 &&
    all.length >= state.previous.length &&
    state.previous.every((item, index) => all[index] === item);
  const skipped = extended ? state.previous.length : 0;
  return { messages: all.slice(skipped).map(toMessage), skipped };
}

function parametersOf(
  params: object,
  keys: readonly string[],
  tools: string[],
): JsonObject | undefined {
  const out: JsonObject = {};
  const fields = params as Record<string, unknown>;
  for (const key of keys) if (fields[key] !== undefined) out[key] = toJson(fields[key]);
  if (tools.length > 0) out.tools = tools;
  return Object.keys(out).length > 0 ? out : undefined;
}

function noteFailure(trace: Trace, error: unknown): void {
  const status = isObject(error) && typeof error.status === "number" ? error.status : null;
  trace.note("openai.request_failed", {
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error ? { name: error.name } : {}),
    ...(status !== null ? { status } : {}),
  });
}

function noteReasoning(trace: Trace, response: OpenAIResponseLike): void {
  for (const item of response.output ?? []) {
    if (item.type !== "reasoning") continue;
    const summary = Array.isArray(item.summary)
      ? item.summary
          .filter((s): s is { text: string } => isObject(s) && typeof s.text === "string")
          .map((s) => s.text)
          .join("\n")
      : "";
    trace.note("reasoning", summary ? { text: summary } : { redacted: true });
  }
}

interface Prepared {
  messages: { role: Role; content: JsonValue }[];
  skipped: number;
  parameters: JsonObject | undefined;
  historyLength: number;
}

function prepareChat(
  trace: Trace,
  params: OpenAIChatParamsLike,
  state: WrapState,
  mode: "new" | "all",
): Prepared {
  const tools = (params.tools ?? [])
    .map((t) => t.function?.name)
    .filter((n): n is string => typeof n === "string");
  const system = params.messages.find((m) => m.role === "system" || m.role === "developer");
  recordContext(
    trace,
    state,
    system ? textOf(system.content) || JSON.stringify(system.content ?? null) : undefined,
    tools,
  );
  const { messages, skipped } = itemsFor(params.messages, state, mode, (item) => {
    const m = isObject(item) ? item : {};
    const { role: r, ...rest } = m;
    return {
      role: role(r),
      content:
        Object.keys(rest).length === 1 && "content" in rest
          ? toJson(rest.content ?? null)
          : toJson(rest),
    };
  });
  return {
    messages,
    skipped,
    parameters: parametersOf(params, CHAT_PARAMETER_KEYS, tools),
    historyLength: params.messages.length,
  };
}

function prepareResponses(
  trace: Trace,
  params: OpenAIResponsesParamsLike,
  state: WrapState,
  mode: "new" | "all",
): Prepared {
  const tools = (params.tools ?? [])
    .map((t) => (typeof t.name === "string" ? t.name : t.type))
    .filter((n): n is string => typeof n === "string");
  recordContext(
    trace,
    state,
    params.instructions === undefined
      ? undefined
      : textOf(params.instructions) || JSON.stringify(params.instructions),
    tools,
  );
  const items = Array.isArray(params.input) ? params.input : [params.input];
  const { messages, skipped } = itemsFor(items, state, mode, (item) => {
    if (typeof item === "string") return { role: "user", content: item };
    const m = isObject(item) ? item : {};
    return { role: role(m.role), content: toJson(m) };
  });
  if (skipped === 0 && params.instructions !== undefined) {
    messages.unshift({ role: "system", content: toJson(params.instructions) });
  }
  return {
    messages,
    skipped,
    parameters: parametersOf(params, RESPONSES_PARAMETER_KEYS, tools),
    historyLength: items.length,
  };
}

/** Record one request/response pair; `call` performs the request and yields the final value. */
async function record<R>(
  trace: Trace,
  api: "chat.completions" | "responses",
  params: OpenAIChatParamsLike | OpenAIResponsesParamsLike,
  prepared: Prepared,
  state: WrapState,
  options: TraceOpenAIOptions,
  call: () => PromiseLike<R>,
  toResult: (value: R) => ModelResult,
): Promise<R> {
  state.calls += 1;
  let response: R | undefined;
  try {
    await trace.model({
      provider: "openai",
      model: params.model,
      name: options.name ? options.name(params, state.calls) : `turn-${state.calls}`,
      messages: prepared.messages,
      ...(prepared.parameters ? { parameters: prepared.parameters } : {}),
      metadata: {
        openai: { api, historyLength: prepared.historyLength, skippedMessages: prepared.skipped },
      },
      execute: async () => {
        response = await call();
        return toResult(response);
      },
    });
  } catch (error) {
    noteFailure(trace, error);
    throw error;
  }
  return response as R;
}

interface ChatChunkLike {
  id?: string;
  model?: string;
  choices?: readonly {
    index?: number;
    delta?: {
      role?: string;
      content?: string | null;
      refusal?: string | null;
      tool_calls?: readonly {
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: OpenAIChatCompletionLike["usage"];
}

/** Fold streamed chunks into the completion they stand for (first choice only). */
export function accumulateChatChunks(chunks: readonly ChatChunkLike[]): OpenAIChatCompletionLike {
  let id: string | undefined;
  let model: string | undefined;
  let content = "";
  let refusal = "";
  let finish: string | null | undefined;
  let usage: OpenAIChatCompletionLike["usage"];
  const calls = new Map<
    number,
    { id?: string; type?: string; function: { name: string; arguments: string } }
  >();
  for (const chunk of chunks) {
    id ??= chunk.id;
    model ??= chunk.model;
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.find((c) => (c.index ?? 0) === 0);
    if (!choice) continue;
    if (choice.delta?.content) content += choice.delta.content;
    if (choice.delta?.refusal) refusal += choice.delta.refusal;
    for (const call of choice.delta?.tool_calls ?? []) {
      const index = call.index ?? 0;
      const current = calls.get(index) ?? { function: { name: "", arguments: "" } };
      if (call.id) current.id = call.id;
      if (call.type) current.type = call.type;
      if (call.function?.name) current.function.name += call.function.name;
      if (call.function?.arguments) current.function.arguments += call.function.arguments;
      calls.set(index, current);
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  }
  const toolCalls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => call);
  return {
    ...(id ? { id } : {}),
    ...(model ? { model } : {}),
    choices: [
      {
        message: {
          role: "assistant",
          content: content || null,
          ...(refusal ? { refusal } : {}),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finish ?? null,
      },
    ],
    ...(usage ? { usage } : {}),
  };
}

/**
 * Pass a stream through to the caller while collecting what it yields; `settle` resolves once
 * the consumer finishes (or stops) iterating, with everything seen so far.
 */
function tee<T>(stream: AsyncIterable<T>): { stream: AsyncIterable<T>; settle: Promise<T[]> } {
  const seen: T[] = [];
  let resolve!: (value: T[]) => void;
  let reject!: (error: unknown) => void;
  const settle = new Promise<T[]>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const source = stream as AsyncIterable<T> & Record<string, unknown>;
  const wrapped: AsyncIterable<T> & Record<string, unknown> = {
    ...source,
    async *[Symbol.asyncIterator]() {
      try {
        for await (const item of stream) {
          seen.push(item);
          yield item;
        }
        resolve(seen);
      } catch (error) {
        reject(error);
        throw error;
      } finally {
        // An early `break` ends the consumer's loop: record what arrived.
        resolve(seen);
      }
    },
  };
  return { stream: wrapped, settle };
}

function wrapChat(
  completions: Record<string, unknown>,
  trace: Trace,
  state: WrapState,
  options: TraceOpenAIOptions,
): Record<string, unknown> {
  return new Proxy(completions, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== "function") return value;
      const original = (value as Fn).bind(target);
      if (prop !== "create") return original;
      return (params: OpenAIChatParamsLike, ...rest: unknown[]) => {
        const prepared = prepareChat(trace, params, state, options.recordMessages ?? "new");
        state.previous = [...params.messages];
        if (params.stream !== true) {
          return record(
            trace,
            "chat.completions",
            params,
            prepared,
            state,
            options,
            () =>
              Promise.resolve(original(params, ...rest) as PromiseLike<OpenAIChatCompletionLike>),
            chatResult,
          );
        }
        // Streaming: hand the stream to the caller and record the folded completion afterwards.
        return Promise.resolve(
          original(params, ...rest) as PromiseLike<AsyncIterable<ChatChunkLike>>,
        ).then((stream) => {
          const { stream: wrapped, settle } = tee(stream);
          record(
            trace,
            "chat.completions",
            params,
            prepared,
            state,
            options,
            () => settle.then(accumulateChatChunks),
            chatResult,
          ).catch(() => undefined);
          return wrapped;
        });
      };
    },
  });
}

interface ResponseEventLike {
  type?: string;
  response?: OpenAIResponseLike;
}

function wrapResponses(
  responses: Record<string, unknown>,
  trace: Trace,
  state: WrapState,
  options: TraceOpenAIOptions,
): Record<string, unknown> {
  return new Proxy(responses, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== "function") return value;
      const original = (value as Fn).bind(target);
      if (prop !== "create") return original;
      return (params: OpenAIResponsesParamsLike, ...rest: unknown[]) => {
        const prepared = prepareResponses(trace, params, state, options.recordMessages ?? "new");
        state.previous = Array.isArray(params.input) ? [...params.input] : [params.input];
        const finish = (response: OpenAIResponseLike) => {
          if (options.notes !== false) noteReasoning(trace, response);
          return response;
        };
        if (params.stream !== true) {
          return record(
            trace,
            "responses",
            params,
            prepared,
            state,
            options,
            () => Promise.resolve(original(params, ...rest) as PromiseLike<OpenAIResponseLike>),
            responsesResult,
          ).then(finish);
        }
        return Promise.resolve(
          original(params, ...rest) as PromiseLike<AsyncIterable<ResponseEventLike>>,
        ).then((stream) => {
          const { stream: wrapped, settle } = tee(stream);
          record(
            trace,
            "responses",
            params,
            prepared,
            state,
            options,
            () =>
              settle.then((events) => {
                // The terminal event carries the whole response; fall back to the last snapshot.
                const terminal = [...events]
                  .reverse()
                  .find(
                    (e) =>
                      e.response && /^response\.(completed|incomplete|failed)$/.test(e.type ?? ""),
                  );
                const last = terminal ?? [...events].reverse().find((e) => e.response);
                return last?.response ?? { output: [] };
              }),
            responsesResult,
          )
            .then(finish)
            .catch(() => undefined);
          return wrapped;
        });
      };
    },
  });
}

/**
 * Wrap an OpenAI client so its model calls are recorded on `trace`. Each
 * `chat.completions.create(...)` and `responses.create(...)` becomes a model span with the model
 * id, request parameters, messages (or input items), the assistant message, tool calls (with
 * their JSON arguments parsed), finish reason and token usage. Streamed calls are recorded once
 * the caller has consumed the stream, from the folded chunks (chat) or the terminal event
 * (responses); the system or developer message, `instructions` and tool names are kept as
 * context when they change; reasoning summaries become `reasoning` notes; a failed request is
 * noted as `openai.request_failed` and re-thrown.
 */
export function traceOpenAI<C extends object>(
  trace: Trace,
  client: C,
  options: TraceOpenAIOptions = {},
): C {
  const state: WrapState = { calls: 0, previous: [], system: undefined, tools: undefined };
  const wrapNamespace = (namespace: object): object =>
    new Proxy(namespace, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target) as unknown;
        if (prop === "chat" && isObject(value)) {
          return new Proxy(value, {
            get(chat, key) {
              const inner = Reflect.get(chat, key, chat) as unknown;
              if (key === "completions" && isObject(inner))
                return wrapChat(inner, trace, state, options);
              return typeof inner === "function" ? (inner as Fn).bind(chat) : inner;
            },
          });
        }
        if (prop === "responses" && isObject(value))
          return wrapResponses(value, trace, state, options);
        if (prop === "beta" && isObject(value)) return wrapNamespace(value);
        return typeof value === "function" ? (value as Fn).bind(target) : value;
      },
    });
  return wrapNamespace(client) as C;
}

export interface OpenAIToolLoopOptions<P extends OpenAIChatParamsLike> {
  /** Request parameters; `messages` is the starting history and is not mutated. */
  params: P;
  /** Implementations of the function tools, by name. The return value becomes the tool result. */
  tools: Record<string, (input: JsonValue) => unknown>;
  /** Policy to evaluate inside a tool's span before it runs; a blocked call returns an error result. */
  guard?: (tool: string, input: JsonValue) => PolicyCall | undefined;
  /** Stop after this many model calls (default 20). */
  maxTurns?: number;
}

export interface OpenAIToolLoopResult<M> {
  /** The last completion from the model. */
  completion: M;
  /** The full history, including every assistant turn and tool result message. */
  messages: { role: string; content?: unknown; tool_calls?: unknown; tool_call_id?: string }[];
  turns: number;
  /** The last finish reason, or `max_turns` when the loop stopped with the model still asking for tools. */
  stopReason: string | null;
}

/**
 * Run the Chat Completions function-calling loop on a client wrapped with `traceOpenAI`: call
 * the model, execute the function tools it asks for through `trace.tool` (so each is a tool span,
 * with an optional policy guard), append one `tool` message per call and repeat until the model
 * stops asking. A tool that throws, is unknown or is blocked by its guard answers with a JSON
 * `{ "error": ... }` result so the model can react. Tools run one after another so their spans
 * nest correctly.
 */
export async function runOpenAIToolLoop<
  P extends OpenAIChatParamsLike,
  M extends OpenAIChatCompletionLike,
>(
  trace: Trace,
  client: { chat: { completions: { create(params: P): PromiseLike<M> } } },
  // The parameter type comes from the client; `params` must then satisfy it.
  options: OpenAIToolLoopOptions<NoInfer<P>>,
): Promise<OpenAIToolLoopResult<M>> {
  const messages: OpenAIToolLoopResult<M>["messages"] = [...options.params.messages];
  const maxTurns = options.maxTurns ?? 20;
  for (let turn = 1; ; turn++) {
    const completion = await client.chat.completions.create({ ...options.params, messages });
    const choice = completion.choices[0];
    const message = choice?.message ?? { role: "assistant", content: null };
    messages.push({ role: "assistant", ...message });
    const calls = message.tool_calls ?? [];
    const stop = choice?.finish_reason ?? null;
    if (calls.length === 0 || (stop !== null && stop !== "tool_calls")) {
      return { completion, messages, turns: turn, stopReason: stop };
    }
    for (const call of calls) {
      const name = call.function?.name ?? "unknown";
      const id = call.id ?? "";
      const input = parseArguments(call.function?.arguments);
      const implementation = options.tools[name];
      let content: string;
      try {
        const result = await trace.tool({
          name,
          arguments: input,
          metadata: { openai: { toolCallId: id } },
          guard: options.guard?.(name, input),
          execute: async () => {
            if (!implementation) throw new Error(`no implementation for tool '${name}'`);
            return toJson(await implementation(input));
          },
        });
        content = typeof result === "string" ? result : JSON.stringify(result);
      } catch (error) {
        content = JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
      }
      messages.push({ role: "tool", tool_call_id: id, content });
    }
    if (turn >= maxTurns) {
      return { completion, messages, turns: turn, stopReason: "max_turns" };
    }
  }
}
