import type {
  IngestEventInput,
  JsonObject,
  JsonValue,
  ModelMessage,
  Outcome,
  TokenUsage,
} from "@shadow/schemas";

/**
 * OTLP/HTTP JSON encoding of ExportTraceServiceRequest (the subset Shadow reads).
 * See docs/integrations/opentelemetry.md for the mapping this module implements.
 */
export interface OtlpAnyValue {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
  bytesValue?: string;
  arrayValue?: { values?: OtlpAnyValue[] };
  kvlistValue?: { values?: OtlpKeyValue[] };
}
export interface OtlpKeyValue {
  key: string;
  value?: OtlpAnyValue;
}
export interface OtlpSpanEvent {
  timeUnixNano?: string | number;
  name?: string;
  attributes?: OtlpKeyValue[];
}
export interface OtlpStatus {
  code?: number | string;
  message?: string;
}
export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name?: string;
  kind?: number | string;
  startTimeUnixNano?: string | number;
  endTimeUnixNano?: string | number;
  attributes?: OtlpKeyValue[];
  events?: OtlpSpanEvent[];
  status?: OtlpStatus;
}
export interface OtlpScopeSpans {
  scope?: { name?: string; version?: string };
  spans?: OtlpSpan[];
}
export interface OtlpResourceSpans {
  resource?: { attributes?: OtlpKeyValue[] };
  scopeSpans?: OtlpScopeSpans[];
}
export interface OtlpTracesPayload {
  resourceSpans?: OtlpResourceSpans[];
}

export interface ConvertedTrace {
  /** Shadow trace id (`trc_otel_<otel trace id>`). */
  traceId: string;
  otelTraceId: string;
  project: string;
  agent: string;
  name: string;
  startedAt: string;
  /** Whether the root span has ended (the trace carries a lifecycle end event). */
  complete: boolean;
  events: IngestEventInput[];
}

export interface ConvertOptions {
  /** Project slug used when the resource has no `service.namespace`. */
  defaultProject: string;
  /** Agent slug used when the resource has no `service.name`. */
  defaultAgent?: string;
}

/** GenAI semantic-convention version the mapping targets. */
export const OTEL_SEMCONV = "1.36.0";

const MODEL_OPERATIONS = new Set(["chat", "text_completion", "generate_content", "embeddings"]);
const AGENT_OPERATIONS = new Set(["invoke_agent", "create_agent"]);
const CLIENT_PREFIXES = ["http.", "db.", "rpc.", "url.", "server.", "messaging."];

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

export function anyValue(value: OtlpAnyValue | undefined): JsonValue {
  if (!value) return null;
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.boolValue !== undefined) return value.boolValue;
  if (value.doubleValue !== undefined) return value.doubleValue;
  if (value.intValue !== undefined) {
    const n = Number(value.intValue);
    return Number.isSafeInteger(n) ? n : String(value.intValue);
  }
  if (value.bytesValue !== undefined) return value.bytesValue;
  if (value.arrayValue) return (value.arrayValue.values ?? []).map(anyValue);
  if (value.kvlistValue) return attributes(value.kvlistValue.values);
  return null;
}

export function attributes(list: OtlpKeyValue[] | undefined): JsonObject {
  const out: JsonObject = {};
  for (const item of list ?? []) {
    if (typeof item?.key === "string") out[item.key] = anyValue(item.value);
  }
  return out;
}

function nanos(value: string | number | undefined): bigint | null {
  if (value === undefined || value === null || value === "") return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function isoFromNanos(value: bigint): string {
  return new Date(Number(value / 1_000_000n)).toISOString();
}

function spanKind(kind: number | string | undefined): string {
  const names = ["UNSPECIFIED", "INTERNAL", "SERVER", "CLIENT", "PRODUCER", "CONSUMER"];
  if (typeof kind === "number") return names[kind] ?? "UNSPECIFIED";
  if (typeof kind === "string") return kind.replace(/^SPAN_KIND_/, "") || "UNSPECIFIED";
  return "UNSPECIFIED";
}

function isError(status: OtlpStatus | undefined): boolean {
  if (!status) return false;
  return status.code === 2 || status.code === "STATUS_CODE_ERROR" || status.code === "ERROR";
}

/** Attribute values that carry JSON (messages, tool arguments) arrive as strings. */
function parseJson(value: JsonValue | undefined): JsonValue | undefined {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!/^[[{]/.test(trimmed)) return value;
  try {
    return JSON.parse(trimmed) as JsonValue;
  } catch {
    return value;
  }
}

function asString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asInt(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function role(value: unknown): ModelMessage["role"] {
  switch (value) {
    case "system":
    case "user":
    case "assistant":
    case "tool":
      return value;
    case "model":
    case "ai":
      return "assistant";
    default:
      return "user";
  }
}

/** Normalise `gen_ai.input.messages` / `gen_ai.output.messages` (or legacy prompt arrays). */
function messages(value: JsonValue | undefined): ModelMessage[] | undefined {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) return undefined;
  return parsed.map((item): ModelMessage => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      return { role: "user", content: item };
    }
    const record = item as JsonObject;
    const content =
      record.content !== undefined ? record.content : (record.parts ?? record.message ?? null);
    return { role: role(record.role), content: content as JsonValue };
  });
}

function toolCalls(value: JsonValue | undefined): { tool: string; arguments: JsonValue }[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) return [];
  const calls: { tool: string; arguments: JsonValue }[] = [];
  for (const message of parsed) {
    if (message === null || typeof message !== "object" || Array.isArray(message)) continue;
    const parts = (message as JsonObject).parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (part === null || typeof part !== "object" || Array.isArray(part)) continue;
      const p = part as JsonObject;
      if (p.type === "tool_call" && typeof p.name === "string") {
        calls.push({ tool: p.name, arguments: parseJson(p.arguments) ?? null });
      }
    }
  }
  return calls;
}

function spanEventAttr(span: OtlpSpan, eventName: string, key: string): JsonValue | undefined {
  for (const event of span.events ?? []) {
    if (event.name === eventName) {
      const attrs = attributes(event.attributes);
      if (attrs[key] !== undefined) return attrs[key];
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Span classification
// ---------------------------------------------------------------------------

interface Mapped {
  opener: Pick<IngestEventInput, "eventType" | "name" | "input">;
  closer: Pick<IngestEventInput, "eventType" | "name" | "output" | "severity" | "tokenUsage">;
  /** Whether the span is an agent span (root wrappers are not duplicated). */
  agent: boolean;
  contentMissing?: boolean;
}

function mapSpan(span: OtlpSpan, attrs: JsonObject, agentSlug: string): Mapped {
  const name = span.name ?? "span";
  const failed = isError(span.status);
  const operation = asString(attrs["gen_ai.operation.name"]);

  if (operation && MODEL_OPERATIONS.has(operation)) {
    const provider = asString(attrs["gen_ai.provider.name"]) ?? asString(attrs["gen_ai.system"]);
    const model =
      asString(attrs["gen_ai.request.model"]) ?? asString(attrs["gen_ai.response.model"]);
    const input =
      messages(attrs["gen_ai.input.messages"]) ??
      messages(spanEventAttr(span, "gen_ai.content.prompt", "gen_ai.prompt")) ??
      [];
    const outputMessages =
      messages(attrs["gen_ai.output.messages"]) ??
      messages(spanEventAttr(span, "gen_ai.content.completion", "gen_ai.completion"));
    const parameters: JsonObject = {};
    for (const [key, value] of Object.entries(attrs)) {
      if (key.startsWith("gen_ai.request.") && key !== "gen_ai.request.model") {
        parameters[key.slice("gen_ai.request.".length)] = value;
      }
    }
    const inputTokens = asInt(attrs["gen_ai.usage.input_tokens"]);
    const outputTokens = asInt(attrs["gen_ai.usage.output_tokens"]);
    const tokenUsage: TokenUsage | null =
      inputTokens !== undefined || outputTokens !== undefined
        ? {
            inputTokens: inputTokens ?? 0,
            outputTokens: outputTokens ?? 0,
            totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0),
          }
        : null;
    const finish = parseJson(attrs["gen_ai.response.finish_reasons"]);
    const finishReason = Array.isArray(finish) ? asString(finish[0] ?? null) : asString(finish);
    const calls = toolCalls(attrs["gen_ai.output.messages"]);
    const message: ModelMessage = outputMessages?.[0] ?? { role: "assistant", content: null };
    return {
      opener: {
        eventType: "model.request",
        name: model ?? name,
        input: {
          provider: provider ?? "unknown",
          model: model ?? "unknown",
          messages: input,
          ...(Object.keys(parameters).length > 0 ? { parameters } : {}),
        },
      },
      closer: {
        eventType: "model.response",
        name: model ?? name,
        output: {
          message,
          ...(finishReason ? { finishReason } : {}),
          ...(calls.length > 0 ? { toolCalls: calls } : {}),
          ...(failed ? { error: { message: span.status?.message ?? "error" } } : {}),
        },
        severity: failed ? "error" : "info",
        tokenUsage,
      },
      agent: false,
      contentMissing: input.length === 0 && !outputMessages,
    };
  }

  if (operation === "execute_tool") {
    const tool = asString(attrs["gen_ai.tool.name"]) ?? name;
    const args = parseJson(attrs["gen_ai.tool.call.arguments"]) ?? null;
    const result = parseJson(attrs["gen_ai.tool.call.result"]) ?? null;
    const code = asString(attrs["error.type"]);
    return {
      opener: { eventType: "tool.request", name: tool, input: { tool, arguments: args } },
      closer: failed
        ? {
            eventType: "tool.error",
            name: tool,
            output: {
              error: {
                message: span.status?.message ?? code ?? "tool call failed",
                ...(code ? { code } : {}),
              },
            },
            severity: "error",
            tokenUsage: null,
          }
        : {
            eventType: "tool.response",
            name: tool,
            output: { result },
            severity: "info",
            tokenUsage: null,
          },
      agent: false,
    };
  }

  if (operation && AGENT_OPERATIONS.has(operation)) {
    const agentName = asString(attrs["gen_ai.agent.name"]) ?? agentSlug;
    return {
      opener: { eventType: "agent.started", name: agentName, input: { agent: agentName } },
      closer: {
        eventType: "agent.completed",
        name: agentName,
        output: failed ? { error: { message: span.status?.message ?? "agent failed" } } : {},
        severity: failed ? "error" : "info",
        tokenUsage: null,
      },
      agent: true,
    };
  }

  const kind = spanKind(span.kind);
  const clientAttrs = Object.fromEntries(
    Object.entries(attrs).filter(([key]) => CLIENT_PREFIXES.some((p) => key.startsWith(p))),
  );
  if (kind === "CLIENT" && Object.keys(clientAttrs).length > 0) {
    const status =
      attrs["http.response.status_code"] ??
      attrs["http.status_code"] ??
      attrs["rpc.grpc.status_code"];
    return {
      opener: { eventType: "tool.request", name, input: { tool: name, arguments: clientAttrs } },
      closer: failed
        ? {
            eventType: "tool.error",
            name,
            output: {
              error: {
                message: span.status?.message ?? "request failed",
                ...(asString(attrs["error.type"]) ? { code: asString(attrs["error.type"]) } : {}),
              },
            },
            severity: "error",
            tokenUsage: null,
          }
        : {
            eventType: "tool.response",
            name,
            output: { result: { status: status ?? null } },
            severity: "info",
            tokenUsage: null,
          },
      agent: false,
    };
  }

  return {
    opener: { eventType: "otel.span_started", name, input: { kind } },
    closer: {
      eventType: "otel.span_ended",
      name,
      output: failed ? { error: { message: span.status?.message ?? "error" } } : {},
      severity: failed ? "error" : "info",
      tokenUsage: null,
    },
    agent: false,
  };
}

/** Shadow-specific span events that opt in to context and policy recording. */
function reservedEvents(
  span: OtlpSpan,
  spanId: string,
  openerId: string,
  parentSpanId: string | null,
): { at: bigint; event: IngestEventInput }[] {
  const out: { at: bigint; event: IngestEventInput }[] = [];
  for (const [index, spanEvent] of (span.events ?? []).entries()) {
    const at = nanos(spanEvent.timeUnixNano) ?? nanos(span.startTimeUnixNano) ?? 0n;
    const attrs = attributes(spanEvent.attributes);
    const base = {
      // Deterministic ids so a re-sent span does not duplicate its events.
      id: `${openerId.replace(/_start$/, "")}_ev${index}`,
      spanId,
      parentSpanId,
      parentEventId: openerId,
      timestamp: isoFromNanos(at),
      source: "otlp",
      metadata: { otel: { spanEvent: spanEvent.name ?? "" } },
    };
    if (spanEvent.name === "shadow.context.set" && typeof attrs.key === "string") {
      out.push({
        at,
        event: {
          ...base,
          eventType: "context.added",
          name: attrs.key,
          output: { key: attrs.key, value: parseJson(attrs.value) ?? null },
        },
      });
    } else if (spanEvent.name === "shadow.context.remove" && typeof attrs.key === "string") {
      out.push({
        at,
        event: {
          ...base,
          eventType: "context.removed",
          name: attrs.key,
          output: { key: attrs.key },
        },
      });
    } else if (spanEvent.name === "shadow.policy.evaluated" && typeof attrs.policy === "string") {
      const decision = attrs.decision;
      if (decision === "allow" || decision === "deny" || decision === "approval_required") {
        out.push({
          at,
          event: {
            ...base,
            eventType: "policy.evaluated",
            name: attrs.policy,
            severity: decision === "allow" ? "info" : "warn",
            output: {
              policy: attrs.policy,
              decision,
              ...(typeof attrs.reason === "string" ? { reason: attrs.reason } : {}),
              ...(attrs.subject !== undefined ? { subject: parseJson(attrs.subject) ?? null } : {}),
            },
          },
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

interface Emission {
  at: bigint;
  /** Ordering within the same instant: trace start, openers, span events, closers, trace end. */
  phase: number;
  key: string;
  event: IngestEventInput;
}

/** Convert an OTLP traces payload into one Shadow trace per OpenTelemetry trace id. */
export function convertOtlpTraces(
  payload: OtlpTracesPayload,
  options: ConvertOptions,
): ConvertedTrace[] {
  const groups = new Map<
    string,
    { resource: JsonObject; scope: string | undefined; spans: OtlpSpan[] }
  >();
  for (const resourceSpans of payload.resourceSpans ?? []) {
    const resource = attributes(resourceSpans.resource?.attributes);
    for (const scopeSpans of resourceSpans.scopeSpans ?? []) {
      for (const span of scopeSpans.spans ?? []) {
        if (typeof span?.traceId !== "string" || typeof span.spanId !== "string") continue;
        const group = groups.get(span.traceId) ?? {
          resource,
          scope: scopeSpans.scope?.name,
          spans: [],
        };
        group.spans.push(span);
        groups.set(span.traceId, group);
      }
    }
  }

  const traces: ConvertedTrace[] = [];
  for (const [otelTraceId, group] of groups) {
    const project = asString(group.resource["service.namespace"]) ?? options.defaultProject;
    const agent = asString(group.resource["service.name"]) ?? options.defaultAgent ?? "otel-agent";
    const byId = new Map(group.spans.map((s) => [s.spanId, s]));
    const starts = new Map<string, bigint>();
    for (const span of group.spans) starts.set(span.spanId, nanos(span.startTimeUnixNano) ?? 0n);
    const roots = group.spans.filter((s) => !s.parentSpanId || !byId.has(s.parentSpanId));
    const root = [...(roots.length > 0 ? roots : group.spans)].sort((a, b) =>
      compareBigint(starts.get(a.spanId) ?? 0n, starts.get(b.spanId) ?? 0n),
    )[0];
    if (!root) continue;
    const rootStart = starts.get(root.spanId) ?? 0n;
    const rootEnd = nanos(root.endTimeUnixNano);
    const rootAttrs = attributes(root.attributes);
    const rootMapped = mapSpan(root, rootAttrs, agent);
    const traceId = `trc_otel_${otelTraceId}`;

    const emissions: Emission[] = [];
    const openerIds = new Map<string, string>();
    for (const span of group.spans) openerIds.set(span.spanId, `evt_otel_${span.spanId}_start`);

    emissions.push({
      at: rootStart,
      phase: 0,
      key: "trace",
      event: {
        id: `evt_otel_${otelTraceId}_trace_start`,
        eventType: "trace.started",
        name: "trace.started",
        timestamp: isoFromNanos(rootStart),
        source: "otlp",
        spanId: null,
        parentSpanId: null,
        input: { project, agent, otelTraceId },
        metadata: { otel: { traceId: otelTraceId, semconv: OTEL_SEMCONV } },
      },
    });
    // A root that is not itself an agent span still gets the agent wrapper the UI expects.
    const wrapAgent = !rootMapped.agent;
    if (wrapAgent) {
      emissions.push({
        at: rootStart,
        phase: 1,
        key: "agent",
        event: {
          id: `evt_otel_${otelTraceId}_agent_start`,
          eventType: "agent.started",
          name: agent,
          timestamp: isoFromNanos(rootStart),
          source: "otlp",
          spanId: `spn_${otelTraceId}_agent`,
          parentSpanId: null,
          parentEventId: null,
          input: { agent },
          metadata: { otel: { traceId: otelTraceId } },
        },
      });
    }

    for (const span of group.spans) {
      const attrs = attributes(span.attributes);
      const mapped = span === root ? rootMapped : mapSpan(span, attrs, agent);
      const start = starts.get(span.spanId) ?? 0n;
      const end = nanos(span.endTimeUnixNano);
      const spanId = `spn_${span.spanId}`;
      const parentInSet =
        span.parentSpanId && byId.has(span.parentSpanId) ? span.parentSpanId : null;
      const parentSpanId = parentInSet
        ? `spn_${parentInSet}`
        : wrapAgent
          ? `spn_${otelTraceId}_agent`
          : null;
      const parentEventId = parentInSet
        ? (openerIds.get(parentInSet) ?? null)
        : wrapAgent
          ? `evt_otel_${otelTraceId}_agent_start`
          : null;
      const openerId = openerIds.get(span.spanId) as string;
      const otel = {
        traceId: otelTraceId,
        spanId: span.spanId,
        ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
        kind: spanKind(span.kind),
        ...(group.scope ? { scope: group.scope } : {}),
        attributes: attrs,
        ...(span.status ? { status: span.status as unknown as JsonObject } : {}),
        ...(mapped.contentMissing ? { contentMissing: true } : {}),
        semconv: OTEL_SEMCONV,
      };
      emissions.push({
        at: start,
        phase: 2,
        key: span.spanId,
        event: {
          id: openerId,
          eventType: mapped.opener.eventType,
          name: mapped.opener.name,
          input: mapped.opener.input,
          timestamp: isoFromNanos(start),
          source: "otlp",
          spanId,
          parentSpanId,
          parentEventId,
          metadata: { otel },
        },
      });
      for (const reserved of reservedEvents(span, spanId, openerId, parentSpanId)) {
        emissions.push({ at: reserved.at, phase: 3, key: span.spanId, event: reserved.event });
      }
      if (end !== null) {
        emissions.push({
          at: end,
          phase: 4,
          key: span.spanId,
          event: {
            id: `evt_otel_${span.spanId}_end`,
            eventType: mapped.closer.eventType,
            name: mapped.closer.name,
            output: mapped.closer.output,
            severity: mapped.closer.severity,
            tokenUsage: mapped.closer.tokenUsage ?? null,
            timestamp: isoFromNanos(end),
            durationMs: Number((end - start) / 1_000_000n),
            source: "otlp",
            spanId,
            parentSpanId,
            parentEventId: openerId,
            metadata: { otel: { traceId: otelTraceId, spanId: span.spanId } },
          },
        });
      }
    }

    const complete = rootEnd !== null;
    if (complete) {
      const failed = isError(root.status);
      const outcome: Outcome = failed
        ? { kind: "error", label: `Failed: ${root.status?.message ?? "span status ERROR"}` }
        : { kind: "completed", label: "Completed" };
      if (wrapAgent) {
        emissions.push({
          at: rootEnd,
          phase: 5,
          key: "agent",
          event: {
            id: `evt_otel_${otelTraceId}_agent_end`,
            eventType: "agent.completed",
            name: agent,
            timestamp: isoFromNanos(rootEnd),
            durationMs: Number((rootEnd - rootStart) / 1_000_000n),
            source: "otlp",
            spanId: `spn_${otelTraceId}_agent`,
            parentSpanId: null,
            parentEventId: `evt_otel_${otelTraceId}_agent_start`,
            output: { outcome },
            severity: failed ? "error" : "info",
            metadata: { otel: { traceId: otelTraceId } },
          },
        });
      }
      emissions.push({
        at: rootEnd,
        phase: 6,
        key: "trace",
        event: {
          id: `evt_otel_${otelTraceId}_trace_end`,
          eventType: failed ? "trace.failed" : "trace.completed",
          name: failed ? "trace.failed" : "trace.completed",
          timestamp: isoFromNanos(rootEnd),
          source: "otlp",
          spanId: null,
          parentSpanId: null,
          output: { outcome },
          severity: failed ? "error" : "info",
          metadata: { otel: { traceId: otelTraceId } },
        },
      });
    }

    emissions.sort(
      (a, b) => compareBigint(a.at, b.at) || a.phase - b.phase || a.key.localeCompare(b.key),
    );
    traces.push({
      traceId,
      otelTraceId,
      project,
      agent,
      name: root.name ?? `otel ${otelTraceId}`,
      startedAt: isoFromNanos(rootStart),
      complete,
      events: emissions.map((e) => e.event),
    });
  }
  return traces;
}

function compareBigint(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
