import type { JsonObject, JsonValue, ModelResult, PolicyCall, TokenUsage } from "@shadow/schemas";
import { toJson } from "./pointer.js";
import type { Trace } from "./trace.js";

/**
 * Recording for agents built directly on the Anthropic Messages API.
 *
 * `traceAnthropic(trace, client)` returns the same client with `messages.create` and
 * `messages.stream` (also under `client.beta`) recorded as model spans; everything else passes
 * through untouched. `runAnthropicToolLoop` runs the standard tool-use loop with every tool
 * execution recorded as a tool span.
 *
 * This module has no dependency on `@anthropic-ai/sdk`: the client is matched structurally, so
 * the caller keeps the SDK's own types (`traceAnthropic` returns the type it was given).
 */

type Fn = (...args: unknown[]) => unknown;

interface Block {
  type: string;
  [key: string]: unknown;
}

/** The part of a Messages API response this adapter reads. */
export interface AnthropicMessageLike {
  content: readonly { type: string }[];
  stop_reason?: string | null;
  model?: string;
  id?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
}

/** The part of the request parameters this adapter reads. */
export interface AnthropicCreateParamsLike {
  model: string;
  messages: readonly { role: string; content: unknown }[];
  system?: unknown;
  tools?: readonly { name?: string }[];
  stream?: boolean;
}

export interface TraceAnthropicOptions {
  /** Step name for each call (default `turn-N`, counting recorded calls). */
  name?: (params: AnthropicCreateParamsLike, call: number) => string;
  /**
   * `"new"` (default) records only the messages added since the previous recorded call when
   * the history was extended in place, which keeps long loops linear in size. `"all"` records
   * the full `messages` array on every call.
   */
  recordMessages?: "new" | "all";
  /** Record `thinking` blocks as `thinking` notes (default true). */
  notes?: boolean;
}

/** Request parameters worth keeping on the model span; message content is recorded separately. */
const PARAMETER_KEYS = [
  "max_tokens",
  "temperature",
  "top_p",
  "top_k",
  "stop_sequences",
  "tool_choice",
  "thinking",
  "output_config",
  "service_tier",
  "speed",
  "metadata",
] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is Block => isObject(b) && b.type === "text" && typeof b.text === "string")
    .map((b) => String(b.text))
    .join("\n");
}

/**
 * Token usage in Shadow's convention: the API reports cache reads and cache writes outside
 * `input_tokens`, while `inputTokens` here is the whole prompt and `cachedInputTokens` the part
 * served from cache.
 */
export function anthropicTokenUsage(usage: AnthropicMessageLike["usage"]): TokenUsage | undefined {
  if (!usage || (usage.input_tokens === undefined && usage.output_tokens === undefined)) {
    return undefined;
  }
  const cached = usage.cache_read_input_tokens ?? 0;
  const input = (usage.input_tokens ?? 0) + cached + (usage.cache_creation_input_tokens ?? 0);
  const output = usage.output_tokens ?? 0;
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
    ...(cached > 0 ? { cachedInputTokens: cached } : {}),
  };
}

function toModelResult(message: AnthropicMessageLike): ModelResult {
  const toolCalls = message.content
    .filter((b): b is Block => b.type === "tool_use")
    .map((b) => ({
      tool: typeof b.name === "string" ? b.name : "unknown",
      arguments: toJson(b.input ?? null),
      ...(typeof b.id === "string" ? { id: b.id } : {}),
    }));
  return {
    message: { role: "assistant", content: toJson(message.content) },
    ...(message.stop_reason ? { finishReason: message.stop_reason } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    tokenUsage: anthropicTokenUsage(message.usage),
  };
}

interface WrapState {
  calls: number;
  previous: readonly unknown[];
  system: string | undefined;
  tools: string | undefined;
}

function recordContext(trace: Trace, params: AnthropicCreateParamsLike, state: WrapState): void {
  const system =
    params.system === undefined
      ? undefined
      : textOf(params.system) || JSON.stringify(params.system);
  if (system !== undefined && system !== state.system) {
    state.system = system;
    trace.context.set("system", system);
  }
  const names = (params.tools ?? []).map((t) => t.name).filter((n): n is string => !!n);
  const tools = names.join("\u0000");
  if (names.length > 0 && tools !== state.tools) {
    state.tools = tools;
    trace.context.set("tools", names);
  }
}

/** Messages to record for this call, and how many earlier ones were left out. */
function messagesFor(
  params: AnthropicCreateParamsLike,
  state: WrapState,
  mode: "new" | "all",
): {
  messages: { role: "system" | "user" | "assistant" | "tool"; content: JsonValue }[];
  skipped: number;
} {
  const all = params.messages;
  const extended =
    mode === "new" &&
    state.previous.length > 0 &&
    all.length >= state.previous.length &&
    state.previous.every((message, index) => all[index] === message);
  const skipped = extended ? state.previous.length : 0;
  const role = (value: string): "system" | "user" | "assistant" | "tool" =>
    value === "assistant" || value === "system" || value === "tool" ? value : "user";
  const messages = all
    .slice(skipped)
    .map((m) => ({ role: role(m.role), content: toJson(m.content) }));
  if (skipped === 0 && params.system !== undefined) {
    messages.unshift({ role: "system", content: toJson(params.system) });
  }
  return { messages, skipped };
}

function parametersOf(params: AnthropicCreateParamsLike): JsonObject | undefined {
  const out: JsonObject = {};
  // The caller's parameter type is its SDK's own; read the optional fields structurally.
  const fields = params as unknown as Record<string, unknown>;
  for (const key of PARAMETER_KEYS) {
    if (fields[key] !== undefined) out[key] = toJson(fields[key]);
  }
  const names = (params.tools ?? []).map((t) => t.name).filter((n): n is string => !!n);
  if (names.length > 0) out.tools = names;
  return Object.keys(out).length > 0 ? out : undefined;
}

function noteThinking(trace: Trace, message: AnthropicMessageLike): void {
  for (const block of message.content as readonly Block[]) {
    if (block.type === "thinking") {
      const text = typeof block.thinking === "string" ? block.thinking : "";
      trace.note("thinking", text ? { text } : { redacted: true });
    } else if (block.type === "redacted_thinking") {
      trace.note("thinking", { redacted: true });
    }
  }
}

function noteFailure(trace: Trace, error: unknown): void {
  const status = isObject(error) && typeof error.status === "number" ? error.status : null;
  trace.note("anthropic.request_failed", {
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error ? { name: error.name } : {}),
    ...(status !== null ? { status } : {}),
  });
}

/** Record one request/response pair; `call` performs the request and yields the final message. */
async function record<M extends AnthropicMessageLike>(
  trace: Trace,
  params: AnthropicCreateParamsLike,
  state: WrapState,
  options: TraceAnthropicOptions,
  call: () => PromiseLike<M>,
): Promise<M> {
  recordContext(trace, params, state);
  const { messages, skipped } = messagesFor(params, state, options.recordMessages ?? "new");
  state.calls += 1;
  state.previous = [...params.messages];
  const parameters = parametersOf(params);
  let response: M | undefined;
  try {
    await trace.model({
      provider: "anthropic",
      model: params.model,
      name: options.name ? options.name(params, state.calls) : `turn-${state.calls}`,
      messages,
      ...(parameters ? { parameters } : {}),
      metadata: { anthropic: { historyLength: params.messages.length, skippedMessages: skipped } },
      execute: async () => {
        response = await call();
        return toModelResult(response);
      },
    });
  } catch (error) {
    noteFailure(trace, error);
    throw error;
  }
  // `execute` either assigned the response or threw, and a throw never reaches this line.
  const message = response as M;
  if (options.notes !== false) noteThinking(trace, message);
  return message;
}

function wrapMessages(
  messages: Record<string, unknown>,
  trace: Trace,
  state: WrapState,
  options: TraceAnthropicOptions,
): Record<string, unknown> {
  return new Proxy(messages, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== "function") return value;
      const original = (value as Fn).bind(target);
      if (prop === "create") {
        return (params: AnthropicCreateParamsLike, ...rest: unknown[]) => {
          // A raw event stream has no final message to record; use `messages.stream()` instead.
          if (params.stream === true) return original(params, ...rest);
          return record(trace, params, state, options, () =>
            Promise.resolve(original(params, ...rest) as PromiseLike<AnthropicMessageLike>),
          );
        };
      }
      if (prop === "stream") {
        return (params: AnthropicCreateParamsLike, ...rest: unknown[]) => {
          const stream = original(params, ...rest);
          if (isObject(stream) && typeof stream.finalMessage === "function") {
            const finalMessage = (stream.finalMessage as Fn).bind(stream);
            // Recording follows the stream in the background; the caller consumes it as usual.
            record(trace, params, state, options, () =>
              Promise.resolve(finalMessage() as PromiseLike<AnthropicMessageLike>),
            ).catch(() => undefined);
          }
          return stream;
        };
      }
      return original;
    },
  });
}

/**
 * Wrap an Anthropic client so its Messages API calls are recorded on `trace`. Each
 * `messages.create(...)` (non-streaming) and `messages.stream(...)` becomes a model span with
 * the model id, request parameters, content blocks, stop reason and token usage; `thinking`
 * blocks become notes; the system prompt and tool names are recorded as context when they
 * change; a failed request is noted as `anthropic.request_failed` and re-thrown.
 */
export function traceAnthropic<C extends object>(
  trace: Trace,
  client: C,
  options: TraceAnthropicOptions = {},
): C {
  const state: WrapState = { calls: 0, previous: [], system: undefined, tools: undefined };
  const wrapNamespace = (namespace: object): object =>
    new Proxy(namespace, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target) as unknown;
        if (prop === "messages" && isObject(value)) {
          return wrapMessages(value, trace, state, options);
        }
        if (prop === "beta" && isObject(value)) return wrapNamespace(value);
        return typeof value === "function" ? (value as Fn).bind(target) : value;
      },
    });
  return wrapNamespace(client) as C;
}

export interface AnthropicToolLoopOptions<P extends AnthropicCreateParamsLike> {
  /** Request parameters; `messages` is the starting history and is not mutated. */
  params: P;
  /** Implementations of the client tools, by name. The return value becomes the tool result. */
  tools: Record<string, (input: JsonValue) => unknown>;
  /** Policy to evaluate inside a tool's span before it runs; a blocked call returns an error result. */
  guard?: (tool: string, input: JsonValue) => PolicyCall | undefined;
  /** Stop after this many model calls (default 20). */
  maxTurns?: number;
}

export interface AnthropicToolLoopResult<M> {
  /** The last response from the model. */
  message: M;
  /** The full history, including every assistant turn and tool result. */
  messages: { role: string; content: unknown }[];
  turns: number;
  /** `max_turns` when the loop stopped at `maxTurns` with the model still asking for tools. */
  stopReason: string | null;
}

/**
 * Run the Messages API tool-use loop on a client wrapped with `traceAnthropic`: call the model,
 * execute the client tools it asks for through `trace.tool` (so each is a tool span, with an
 * optional policy guard), send every result back in one user message and repeat until the model
 * stops asking. A tool that throws, is unknown or is blocked by its guard produces an
 * `is_error` result so the model can react. `pause_turn` (server tools) continues the turn;
 * `max_tokens` and `refusal` end the loop without running tools.
 *
 * Tools run one after another so their spans nest correctly; use the SDK's own loop with a
 * wrapped client if you need them concurrent and do not need tool spans.
 */
export async function runAnthropicToolLoop<
  P extends AnthropicCreateParamsLike,
  M extends AnthropicMessageLike,
>(
  trace: Trace,
  client: { messages: { create(params: P): PromiseLike<M> } },
  // The parameter type comes from the client; `params` must then satisfy it.
  options: AnthropicToolLoopOptions<NoInfer<P>>,
): Promise<AnthropicToolLoopResult<M>> {
  const messages: { role: string; content: unknown }[] = [...options.params.messages];
  const maxTurns = options.maxTurns ?? 20;
  for (let turn = 1; ; turn++) {
    const message = await client.messages.create({ ...options.params, messages });
    messages.push({ role: "assistant", content: message.content });
    const stop = message.stop_reason ?? null;
    if (stop === "pause_turn" && turn < maxTurns) continue;
    const toolUses = (message.content as readonly Block[]).filter((b) => b.type === "tool_use");
    if (stop !== "tool_use" || toolUses.length === 0) {
      return { message, messages, turns: turn, stopReason: stop };
    }
    const results: Block[] = [];
    for (const block of toolUses) {
      const name = typeof block.name === "string" ? block.name : "unknown";
      const id = typeof block.id === "string" ? block.id : "";
      const input = toJson(block.input ?? null);
      const implementation = options.tools[name];
      try {
        const result = await trace.tool({
          name,
          arguments: input,
          metadata: { anthropic: { toolUseId: id } },
          guard: options.guard?.(name, input),
          execute: async () => {
            if (!implementation) throw new Error(`no implementation for tool '${name}'`);
            return toJson(await implementation(input));
          },
        });
        results.push({
          type: "tool_result",
          tool_use_id: id,
          content: typeof result === "string" ? result : JSON.stringify(result),
        });
      } catch (error) {
        results.push({
          type: "tool_result",
          tool_use_id: id,
          is_error: true,
          content: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // Every result goes back in a single user message.
    messages.push({ role: "user", content: results });
    if (turn >= maxTurns) {
      return { message, messages, turns: turn, stopReason: "max_turns" };
    }
  }
}
