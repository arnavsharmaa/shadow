import { toJson } from "@shadow/core";
import type {
  ImportAnthropicBody,
  IngestEventInput,
  JsonObject,
  JsonValue,
  Outcome,
  TokenUsage,
} from "@shadow/schemas";

/**
 * Converts a stored Anthropic Messages API conversation into Shadow events (see
 * docs/integrations/anthropic.md). Pure: ids and the start time are injected, so the same
 * input always produces the same events.
 *
 * Each assistant message is one model span; `tool_use` blocks open tool spans that the matching
 * `tool_result` blocks of the next user message close; server tools (`server_tool_use` and its
 * `*_tool_result` block in the same assistant message) become tool spans too. The conversation
 * history is the trace's state: every message is appended at `/messages/-`.
 */

type Block = JsonObject & { type: string };

export interface AnthropicConversion {
  name: string;
  startedAt: string;
  events: IngestEventInput[];
  summary: {
    turns: number;
    toolCalls: number;
    serverToolCalls: number;
    /** `tool_use` blocks whose `tool_result` is not in the history. */
    unmatchedToolUses: number;
    /** `tool_result` blocks that answer no recorded `tool_use`. */
    orphanToolResults: number;
    stopReason: string | null;
  };
}

export interface ConvertOptions {
  nextId(prefix: "evt" | "spn"): string;
  /** Used when the body has no `startedAt`. */
  now: number;
}

function blocksOf(content: ImportAnthropicBody["messages"][number]["content"]): Block[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map((block) => toJson(block) as Block);
}

function textOf(blocks: readonly Block[]): string {
  return blocks
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => String(b.text))
    .join("\n");
}

function str(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Text of a `tool_result` content (a string or content blocks), for error messages. */
function resultText(content: JsonValue | undefined): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) =>
        item !== null && typeof item === "object" && !Array.isArray(item) && item.type === "text"
          ? String(item.text ?? "")
          : "",
      )
      .filter((t) => t.length > 0)
      .join("\n");
  }
  return "";
}

/** Server tool results carry an error object in `content` instead of raising. */
function serverToolError(content: JsonValue | undefined): string | null {
  if (content === null || typeof content !== "object" || Array.isArray(content)) return null;
  const type = str(content.type);
  const code = str(content.error_code);
  if (code) return code;
  return type && type.endsWith("_error") ? type : null;
}

function usageOf(
  response: NonNullable<ImportAnthropicBody["responses"]>[number] | undefined,
): TokenUsage | null {
  const usage = response?.usage;
  if (!usage || (usage.input_tokens === undefined && usage.output_tokens === undefined))
    return null;
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cached = usage.cache_read_input_tokens ?? undefined;
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
    ...(cached !== undefined && cached !== null ? { cachedInputTokens: cached } : {}),
  };
}

function outcomeFor(
  stopReason: string | null,
  lastRole: string,
  pendingTools: number,
  finalText: string,
): Outcome {
  const summary = finalText ? { summary: finalText.slice(0, 500) } : {};
  if (
    lastRole !== "assistant" ||
    pendingTools > 0 ||
    stopReason === "tool_use" ||
    stopReason === "pause_turn"
  ) {
    return { kind: "incomplete", label: "Conversation in progress", ...summary };
  }
  if (stopReason === "max_tokens")
    return { kind: "truncated", label: "Stopped at max_tokens", ...summary };
  if (stopReason === "refusal") return { kind: "refusal", label: "Model refused", ...summary };
  return { kind: "completed", label: "Completed", ...summary };
}

export function convertAnthropicMessages(
  body: ImportAnthropicBody,
  options: ConvertOptions,
): AnthropicConversion {
  const startMs = body.startedAt ? Date.parse(body.startedAt) : options.now;
  const events: IngestEventInput[] = [];
  // One millisecond per event keeps the recorded order when sorted by time.
  const push = (event: IngestEventInput): string => {
    const id = options.nextId("evt");
    events.push({
      ...event,
      id,
      timestamp: new Date(startMs + events.length).toISOString(),
      source: "anthropic",
    });
    return id;
  };

  const firstUser = body.messages.find((m) => m.role === "user");
  const firstText = firstUser ? textOf(blocksOf(firstUser.content)) : "";
  const name = body.name ?? (firstText ? firstText.slice(0, 120) : "Anthropic conversation");
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
  const systemBlocks = body.system === undefined ? [] : blocksOf(body.system);
  if (systemBlocks.length > 0) {
    push({
      eventType: "context.added",
      name: "system",
      ...inAgent,
      output: { key: "system", value: textOf(systemBlocks) || toJson(systemBlocks) },
    });
  }
  const toolNames = (body.tools ?? []).map((t) => t.name);
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
  let serverToolCalls = 0;
  let orphanToolResults = 0;
  let stopReason: string | null = null;
  let finalText = "";
  let sinceLastCall: { role: string; content: JsonValue }[] = systemBlocks.length
    ? [{ role: "system", content: toJson(systemBlocks) }]
    : [];

  for (const message of body.messages) {
    const blocks = blocksOf(message.content);
    const appended = { role: message.role, content: toJson(blocks) };

    if (message.role === "assistant") {
      const response = body.responses?.[turns];
      turns += 1;
      const toolUses = blocks.filter((b) => b.type === "tool_use");
      const recorded = response?.stop_reason ?? null;
      stopReason = recorded ?? (toolUses.length > 0 ? "tool_use" : "end_turn");
      finalText = textOf(blocks);
      const model = response?.model ?? body.model ?? "unknown";
      const modelSpan = options.nextId("spn");
      const inModel = { spanId: modelSpan, parentSpanId: agentSpan };
      const stepName = `turn-${turns}`;
      const requestId = push({
        eventType: "model.request",
        name: stepName,
        ...inModel,
        input: {
          provider: "anthropic",
          model,
          // Only the turns added since the previous call; the full history is state `/messages`.
          messages: sinceLastCall,
          ...(toolNames.length > 0 ? { parameters: { tools: toolNames } } : {}),
        },
      });
      const cacheCreation = response?.usage?.cache_creation_input_tokens;
      push({
        eventType: "model.response",
        name: stepName,
        ...inModel,
        parentEventId: requestId,
        severity: stopReason === "max_tokens" || stopReason === "refusal" ? "warn" : "info",
        output: {
          message: { role: "assistant", content: toJson(blocks) },
          finishReason: stopReason,
          ...(toolUses.length > 0
            ? {
                toolCalls: toolUses.map((b) => ({
                  tool: str(b.name) ?? "unknown",
                  arguments: b.input ?? null,
                  id: str(b.id) ?? null,
                })),
              }
            : {}),
        },
        tokenUsage: usageOf(response),
        metadata: {
          anthropic: {
            ...(response?.id ? { responseId: response.id } : {}),
            ...(recorded === null ? { stopReasonInferred: true } : {}),
            ...(typeof cacheCreation === "number"
              ? { usage: { cache_creation_input_tokens: cacheCreation } }
              : {}),
          },
        },
      });
      sinceLastCall = [];

      for (const block of blocks) {
        if (block.type === "thinking" || block.type === "redacted_thinking") {
          const text = block.type === "thinking" ? (str(block.thinking) ?? "") : "";
          push({
            eventType: "agent.note",
            name: "thinking",
            ...inAgent,
            severity: "debug",
            output: text ? { text } : { redacted: true },
          });
        } else if (block.type === "server_tool_use") {
          const id = str(block.id);
          const tool = str(block.name) ?? "server_tool";
          const result = blocks.find(
            (b) => b.type.endsWith("_tool_result") && str(b.tool_use_id) === id,
          );
          serverToolCalls += 1;
          const spanId = options.nextId("spn");
          const inTool = { spanId, parentSpanId: agentSpan };
          const metadata = { anthropic: { server: true, ...(id ? { toolUseId: id } : {}) } };
          const openerId = push({
            eventType: "tool.request",
            name: tool,
            ...inTool,
            input: { tool, arguments: block.input ?? null },
            metadata,
          });
          const error = result ? serverToolError(result.content) : null;
          if (result && error) {
            push({
              eventType: "tool.error",
              name: tool,
              ...inTool,
              parentEventId: openerId,
              severity: "error",
              output: { error: { message: error, code: error } },
              metadata,
            });
          } else if (result) {
            push({
              eventType: "tool.response",
              name: tool,
              ...inTool,
              parentEventId: openerId,
              output: { result: result.content ?? null },
              metadata,
            });
          }
        } else if (block.type === "tool_use") {
          const id = str(block.id);
          const tool = str(block.name) ?? "unknown";
          toolCalls += 1;
          const spanId = options.nextId("spn");
          const openerId = push({
            eventType: "tool.request",
            name: tool,
            spanId,
            parentSpanId: agentSpan,
            input: { tool, arguments: block.input ?? null },
            metadata: { anthropic: id ? { toolUseId: id } : {} },
          });
          if (id) pending.set(id, { spanId, openerId, name: tool });
        }
      }
    } else if (message.role === "user") {
      for (const block of blocks) {
        if (block.type !== "tool_result") continue;
        const id = str(block.tool_use_id);
        const open = id ? pending.get(id) : undefined;
        if (!id || !open) {
          orphanToolResults += 1;
          continue;
        }
        pending.delete(id);
        const failed = block.is_error === true;
        push({
          eventType: failed ? "tool.error" : "tool.response",
          name: open.name,
          spanId: open.spanId,
          parentSpanId: agentSpan,
          parentEventId: open.openerId,
          severity: failed ? "error" : "info",
          output: failed
            ? { error: { message: resultText(block.content) || "tool call failed" } }
            : { result: block.content ?? null },
          metadata: { anthropic: { toolUseId: id } },
        });
      }
      sinceLastCall.push(appended);
    } else {
      // A mid-conversation operator instruction replaces what the agent "knows" as its system prompt.
      push({
        eventType: "context.added",
        name: "system",
        ...inAgent,
        output: { key: "system", value: textOf(blocks) || toJson(blocks) },
        metadata: { anthropic: { midConversation: true } },
      });
      sinceLastCall.push(appended);
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
    stopReason,
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
      serverToolCalls,
      unmatchedToolUses: pending.size,
      orphanToolResults,
      stopReason,
    },
  };
}
