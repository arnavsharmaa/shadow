import { toJson } from "@shadow/core";
import type {
  ImportOpenAIBody,
  IngestEventInput,
  JsonObject,
  JsonValue,
  Outcome,
  TokenUsage,
} from "@shadow/schemas";

/**
 * Converts a stored OpenAI Chat Completions conversation into Shadow events (see
 * docs/integrations/openai.md). Pure: ids and the start time are injected, so the same input
 * always produces the same events.
 *
 * Each assistant message is one model span; its `tool_calls` open tool spans that the `tool`
 * messages with the matching `tool_call_id` close. The conversation history is the trace's
 * state: every message is appended at `/messages/-`.
 */

export interface OpenAIConversion {
  name: string;
  startedAt: string;
  events: IngestEventInput[];
  summary: {
    turns: number;
    toolCalls: number;
    /** `tool_calls` entries whose `tool` message is not in the history. */
    unmatchedToolCalls: number;
    /** `tool` messages that answer no recorded call. */
    orphanToolResults: number;
    finishReason: string | null;
  };
}

export interface ConvertOptions {
  nextId(prefix: "evt" | "spn"): string;
  /** Used when the body has no `startedAt`. */
  now: number;
}

type Message = ImportOpenAIBody["messages"][number];

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part !== null &&
      typeof part === "object" &&
      !Array.isArray(part) &&
      typeof part.text === "string"
        ? String(part.text)
        : "",
    )
    .filter((t) => t.length > 0)
    .join("\n");
}

/** Tool arguments and results are JSON strings; keep them structured when they parse. */
function parseJson(text: unknown): JsonValue {
  if (typeof text !== "string") return toJson(text ?? null);
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return text;
  }
}

/** A tool answer of the form `{ "error": "..." }` (what `runOpenAIToolLoop` sends) is a failure. */
function errorOf(result: JsonValue): string | null {
  if (result === null || typeof result !== "object" || Array.isArray(result)) return null;
  const keys = Object.keys(result);
  return keys.length === 1 && keys[0] === "error" && typeof result.error === "string"
    ? result.error
    : null;
}

function usageOf(
  response: NonNullable<ImportOpenAIBody["responses"]>[number] | undefined,
): TokenUsage | null {
  const usage = response?.usage;
  if (!usage || (usage.prompt_tokens === undefined && usage.completion_tokens === undefined)) {
    return null;
  }
  // OpenAI counts cached prompt tokens inside `prompt_tokens`.
  const input = usage.prompt_tokens ?? 0;
  const output = usage.completion_tokens ?? 0;
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: usage.total_tokens ?? input + output,
    ...(cached > 0 ? { cachedInputTokens: cached } : {}),
  };
}

function outcomeFor(
  finishReason: string | null,
  lastRole: string,
  pendingTools: number,
  finalText: string,
): Outcome {
  const summary = finalText ? { summary: finalText.slice(0, 500) } : {};
  if (lastRole !== "assistant" || pendingTools > 0 || finishReason === "tool_calls") {
    return { kind: "incomplete", label: "Conversation in progress", ...summary };
  }
  if (finishReason === "length")
    return { kind: "truncated", label: "Stopped at max tokens", ...summary };
  if (finishReason === "content_filter") {
    return { kind: "refusal", label: "Stopped by the content filter", ...summary };
  }
  return { kind: "completed", label: "Completed", ...summary };
}

function toolNamesOf(body: ImportOpenAIBody): string[] {
  return (body.tools ?? [])
    .map((t) => t.function?.name ?? t.name)
    .filter((n): n is string => typeof n === "string" && n.length > 0);
}

export function convertOpenAIMessages(
  body: ImportOpenAIBody,
  options: ConvertOptions,
): OpenAIConversion {
  const startMs = body.startedAt ? Date.parse(body.startedAt) : options.now;
  const events: IngestEventInput[] = [];
  const push = (event: IngestEventInput): string => {
    const id = options.nextId("evt");
    events.push({
      ...event,
      id,
      timestamp: new Date(startMs + events.length).toISOString(),
      source: "openai",
    });
    return id;
  };

  const firstUser = body.messages.find((m) => m.role === "user");
  const firstText = firstUser ? textOf(firstUser.content) : "";
  const name = body.name ?? (firstText ? firstText.slice(0, 120) : "OpenAI conversation");
  const agentSpan = options.nextId("spn");
  const inAgent = { spanId: agentSpan, parentSpanId: null };

  push({
    eventType: "trace.started",
    name,
    spanId: null,
    parentSpanId: null,
    input: { name, metadata: body.metadata ?? {} },
  });
  push({
    eventType: "agent.started",
    name: body.agent,
    ...inAgent,
    input: { agent: body.agent, ...(firstText ? { request: firstText } : {}) },
  });
  const toolNames = toolNamesOf(body);
  if (toolNames.length > 0) {
    push({
      eventType: "context.added",
      name: "tools",
      ...inAgent,
      output: { key: "tools", value: toolNames },
    });
  }
  push({
    eventType: "state.patch",
    name: "/messages",
    ...inAgent,
    output: { ops: [{ op: "add", path: "/messages", value: [] }] },
  });

  const pending = new Map<string, { spanId: string; openerId: string; name: string }>();
  let turns = 0;
  let toolCalls = 0;
  let orphanToolResults = 0;
  let finishReason: string | null = null;
  let finalText = "";
  let sinceLastCall: { role: string; content: JsonValue }[] = [];
  const messageJson = (message: Message): JsonObject => toJson(message) as JsonObject;

  for (const message of body.messages) {
    const appended = messageJson(message);

    if (message.role === "assistant") {
      const response = body.responses?.[turns];
      turns += 1;
      const calls = message.tool_calls ?? [];
      const recorded = response?.finish_reason ?? null;
      finishReason = recorded ?? (calls.length > 0 ? "tool_calls" : "stop");
      finalText = textOf(message.content);
      const model = response?.model ?? body.model ?? "unknown";
      const modelSpan = options.nextId("spn");
      const inModel = { spanId: modelSpan, parentSpanId: agentSpan };
      const stepName = `turn-${turns}`;
      const requestId = push({
        eventType: "model.request",
        name: stepName,
        ...inModel,
        input: {
          provider: "openai",
          model,
          // Only the messages added since the previous call; the full history is state `/messages`.
          messages: sinceLastCall,
          ...(toolNames.length > 0 ? { parameters: { tools: toolNames } } : {}),
        },
      });
      push({
        eventType: "model.response",
        name: stepName,
        ...inModel,
        parentEventId: requestId,
        severity: finishReason === "length" || finishReason === "content_filter" ? "warn" : "info",
        output: {
          message: { role: "assistant", content: appended },
          finishReason,
          ...(calls.length > 0
            ? {
                toolCalls: calls.map((c) => ({
                  tool: c.function?.name ?? "unknown",
                  arguments: parseJson(c.function?.arguments),
                  id: c.id ?? null,
                })),
              }
            : {}),
        },
        tokenUsage: usageOf(response),
        metadata: {
          openai: {
            ...(response?.id ? { responseId: response.id } : {}),
            ...(recorded === null ? { finishReasonInferred: true } : {}),
          },
        },
      });
      sinceLastCall = [];

      for (const call of calls) {
        const tool = call.function?.name ?? "unknown";
        toolCalls += 1;
        const spanId = options.nextId("spn");
        const openerId = push({
          eventType: "tool.request",
          name: tool,
          spanId,
          parentSpanId: agentSpan,
          input: { tool, arguments: parseJson(call.function?.arguments) },
          metadata: { openai: call.id ? { toolCallId: call.id } : {} },
        });
        if (call.id) pending.set(call.id, { spanId, openerId, name: tool });
      }
    } else if (message.role === "tool") {
      const id = message.tool_call_id;
      const open = id ? pending.get(id) : undefined;
      if (!id || !open) {
        orphanToolResults += 1;
      } else {
        pending.delete(id);
        const result = parseJson(message.content);
        const error = errorOf(result);
        push({
          eventType: error ? "tool.error" : "tool.response",
          name: open.name,
          spanId: open.spanId,
          parentSpanId: agentSpan,
          parentEventId: open.openerId,
          severity: error ? "error" : "info",
          output: error ? { error: { message: error } } : { result },
          metadata: { openai: { toolCallId: id } },
        });
      }
      sinceLastCall.push({ role: "tool", content: appended });
    } else if (message.role === "user") {
      sinceLastCall.push({ role: "user", content: toJson(message.content ?? null) });
    } else {
      // `system` or `developer`: the agent's instructions, replaced when they appear mid-way.
      const text = textOf(message.content) || JSON.stringify(message.content ?? null);
      push({
        eventType: "context.added",
        name: "system",
        ...inAgent,
        output: { key: "system", value: text },
        metadata: {
          openai: { role: message.role, ...(turns > 0 ? { midConversation: true } : {}) },
        },
      });
      sinceLastCall.push({ role: "system", content: toJson(message.content ?? null) });
    }

    push({
      eventType: "state.patch",
      name: "/messages/-",
      ...inAgent,
      output: { ops: [{ op: "add", path: "/messages/-", value: appended }] },
    });
  }

  const lastRole = body.messages[body.messages.length - 1]?.role ?? "user";
  const outcome = outcomeFor(
    finishReason,
    lastRole,
    pending.size,
    lastRole === "assistant" ? finalText : "",
  );
  push({
    eventType: "agent.completed",
    name: body.agent,
    ...inAgent,
    durationMs: events.length,
    output: { outcome: toJson(outcome) },
  });
  push({
    eventType: "trace.completed",
    name: "trace.completed",
    spanId: null,
    parentSpanId: null,
    output: { outcome: toJson(outcome) },
  });

  return {
    name,
    startedAt: new Date(startMs).toISOString(),
    events,
    summary: {
      turns,
      toolCalls,
      unmatchedToolCalls: pending.size,
      orphanToolResults,
      finishReason,
    },
  };
}
