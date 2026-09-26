import { createHash } from "node:crypto";
import type { Branch, JsonObject, JsonValue, ShadowEvent, TraceExport } from "@shadow/schemas";
import { toJson } from "@shadow/core";
import { SCHEMA_VERSION, SPAN_OPENERS } from "@shadow/schemas";
import {
  type OtlpAnyValue,
  type OtlpKeyValue,
  type OtlpResourceSpans,
  type OtlpSpan,
  type OtlpSpanEvent,
  type OtlpSpanLink,
  type OtlpTracesPayload,
} from "./convert.js";

/**
 * Reverse mapping: a Shadow trace bundle becomes an OTLP `ExportTraceServiceRequest`.
 *
 * Every branch is one OpenTelemetry trace (OTLP has no branch concept); forked branches link
 * their root span to the parent branch's root. Each Shadow span (opener + closer, see
 * `docs/concepts/events.md`) becomes one OTel span carrying the GenAI semantic-convention
 * attributes the importer understands, so a round trip through `POST /otlp/v1/traces`
 * reproduces the model, tool and agent spans. Events that are not span openers or closers
 * (context, state, policy, approvals, notes, lifecycle) become span events; the reserved
 * `shadow.*` names are the ones the importer maps back into Shadow events.
 */

const MAX_ATTRIBUTE_CHARS = 32_768;
const SPAN_KIND_INTERNAL = 1;
const SPAN_KIND_CLIENT = 3;
const STATUS_OK = 1;
const STATUS_ERROR = 2;

/** Event types that close the span opened by their `spanId`. */
const SPAN_CLOSERS = new Set(["tool.response", "tool.error", "model.response", "agent.completed"]);

function hexId(bytes: number, ...parts: string[]): string {
  return createHash("sha256")
    .update(parts.join("\u0000"))
    .digest("hex")
    .slice(0, bytes * 2);
}

/** OTel trace id (16 bytes) for a branch; stable across exports. */
export function otelTraceIdFor(traceId: string, branchId: string): string {
  return hexId(16, "trace", traceId, branchId);
}

/** OTel span id (8 bytes) for a Shadow span or synthetic root. */
export function otelSpanIdFor(traceId: string, branchId: string, key: string): string {
  return hexId(8, "span", traceId, branchId, key);
}

/**
 * Shadow timestamps have millisecond precision, so the event's sequence rides in the
 * nanosecond digits: spans that start and end within the same millisecond keep their
 * recorded order when the payload is sorted by time, as the importer does.
 */
function unixNanos(iso: string, sequence = 0): string {
  const ms = Date.parse(iso);
  const safe = Number.isFinite(ms) ? ms : 0;
  const sub = BigInt(Math.max(0, Math.min(sequence, 999_999)));
  return (BigInt(safe) * 1_000_000n + sub).toString();
}

function truncate(text: string): string {
  return text.length > MAX_ATTRIBUTE_CHARS ? `${text.slice(0, MAX_ATTRIBUTE_CHARS)}…` : text;
}

function anyValueFrom(value: JsonValue): OtlpAnyValue | null {
  if (value === null) return null;
  if (typeof value === "string") return { stringValue: truncate(value) };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value) && Number.isSafeInteger(value)
      ? { intValue: String(value) }
      : { doubleValue: value };
  }
  if (Array.isArray(value) && value.every((v) => v === null || typeof v !== "object")) {
    const values = value.map(anyValueFrom).filter((v): v is OtlpAnyValue => v !== null);
    return { arrayValue: { values } };
  }
  // Complex values travel as JSON strings, as the GenAI conventions do for messages.
  return { stringValue: truncate(JSON.stringify(value)) };
}

function jsonAttr(value: JsonValue | undefined): OtlpAnyValue | null {
  return value === undefined ? null : { stringValue: truncate(JSON.stringify(value)) };
}

class Attrs {
  readonly list: OtlpKeyValue[] = [];
  set(key: string, value: JsonValue | undefined): this {
    if (value === undefined) return this;
    const converted = anyValueFrom(value);
    if (converted) this.list.push({ key, value: converted });
    return this;
  }
  json(key: string, value: JsonValue | undefined): this {
    const converted = jsonAttr(value);
    if (converted) this.list.push({ key, value: converted });
    return this;
  }
  metadata(metadata: JsonObject): this {
    for (const [key, value] of Object.entries(metadata)) this.set(`shadow.metadata.${key}`, value);
    return this;
  }
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function field(value: JsonValue | undefined, key: string): JsonValue | undefined {
  return isObject(value) ? value[key] : undefined;
}

function str(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function errorOf(event: ShadowEvent): { message: string; code?: string } | null {
  const error = field(event.output, "error");
  if (!isObject(error)) return event.severity === "error" ? { message: event.name } : null;
  return {
    message: str(error.message) ?? "error",
    ...(str(error.code) ? { code: str(error.code) } : {}),
  };
}

/** Common attributes so any span or span event can be traced back to its Shadow event. */
function eventAttrs(attrs: Attrs, event: ShadowEvent): Attrs {
  return attrs
    .set("shadow.event.id", event.id)
    .set("shadow.event.type", event.eventType)
    .set("shadow.event.name", event.name)
    .set("shadow.event.sequence", event.sequence)
    .set("shadow.event.severity", event.severity)
    .set("shadow.event.source", event.source);
}

function spanEventFrom(event: ShadowEvent): OtlpSpanEvent {
  const attrs = new Attrs();
  let name = event.eventType;
  switch (event.eventType) {
    case "context.added":
      name = "shadow.context.set";
      attrs.set("key", str(field(event.output, "key")) ?? event.name);
      attrs.json("value", field(event.output, "value") ?? null);
      break;
    case "context.removed":
      name = "shadow.context.remove";
      attrs.set("key", str(field(event.output, "key")) ?? event.name);
      break;
    case "state.patch":
      name = "shadow.state.patch";
      attrs.json("ops", field(event.output, "ops") ?? []);
      break;
    case "state.snapshot":
      name = "shadow.state.snapshot";
      attrs.json("state", field(event.output, "state") ?? {});
      attrs.json("context", field(event.output, "context") ?? {});
      break;
    case "policy.evaluated": {
      name = "shadow.policy.evaluated";
      attrs.set("policy", str(field(event.output, "policy")) ?? event.name);
      attrs.set("decision", str(field(event.output, "decision")));
      attrs.set("reason", str(field(event.output, "reason")));
      attrs.json("subject", field(event.output, "subject"));
      break;
    }
    default:
      attrs.json("shadow.event.input", event.input);
      attrs.json("shadow.event.output", event.output);
  }
  eventAttrs(attrs, event).metadata(event.metadata);
  return {
    name,
    timeUnixNano: unixNanos(event.timestamp, event.sequence),
    attributes: attrs.list,
  };
}

interface ShadowSpan {
  key: string;
  opener: ShadowEvent;
  closer: ShadowEvent | null;
  members: ShadowEvent[];
  /** True when the opener lives in an ancestor branch and only the tail is in this one. */
  partial: boolean;
}

function groupSpans(events: ShadowEvent[]): { spans: ShadowSpan[]; loose: ShadowEvent[] } {
  const spans = new Map<string, ShadowSpan>();
  const loose: ShadowEvent[] = [];
  for (const event of events) {
    if (event.spanId === null) {
      loose.push(event);
      continue;
    }
    const existing = spans.get(event.spanId);
    if (!existing) {
      spans.set(event.spanId, {
        key: event.spanId,
        opener: event,
        closer: SPAN_CLOSERS.has(event.eventType) ? event : null,
        members: [],
        partial: !(event.eventType in SPAN_OPENERS),
      });
      continue;
    }
    if (SPAN_CLOSERS.has(event.eventType) && existing.closer === null) existing.closer = event;
    else existing.members.push(event);
  }
  return { spans: [...spans.values()], loose };
}

function spanAttributes(
  span: ShadowSpan,
  agentSlug: string,
): {
  name: string;
  kind: number;
  attrs: Attrs;
  failed: boolean;
} {
  const { opener, closer } = span;
  const attrs = new Attrs();
  const error = closer ? errorOf(closer) : null;
  switch (opener.eventType) {
    case "model.request": {
      const provider = str(field(opener.input, "provider")) ?? "unknown";
      const model = str(field(opener.input, "model")) ?? opener.name;
      attrs
        .set("gen_ai.operation.name", "chat")
        .set("gen_ai.provider.name", provider)
        .set("gen_ai.request.model", model)
        .json("gen_ai.input.messages", field(opener.input, "messages") ?? []);
      const parameters = field(opener.input, "parameters");
      if (isObject(parameters)) {
        for (const [key, value] of Object.entries(parameters)) {
          attrs.set(`gen_ai.request.${key}`, value);
        }
      }
      if (closer) {
        const message = field(closer.output, "message");
        if (message !== undefined) attrs.json("gen_ai.output.messages", [message]);
        const finish = str(field(closer.output, "finishReason"));
        if (finish) attrs.json("gen_ai.response.finish_reasons", [finish]);
        if (closer.tokenUsage) {
          attrs
            .set("gen_ai.usage.input_tokens", closer.tokenUsage.inputTokens)
            .set("gen_ai.usage.output_tokens", closer.tokenUsage.outputTokens);
        }
        if (closer.estimatedCost) {
          attrs
            .set("shadow.cost.amount", closer.estimatedCost.amount)
            .set("shadow.cost.currency", closer.estimatedCost.currency);
        }
      }
      return { name: `chat ${model}`, kind: SPAN_KIND_CLIENT, attrs, failed: error !== null };
    }
    case "tool.request": {
      const tool = str(field(opener.input, "tool")) ?? opener.name;
      attrs
        .set("gen_ai.operation.name", "execute_tool")
        .set("gen_ai.tool.name", tool)
        .json("gen_ai.tool.call.arguments", field(opener.input, "arguments") ?? null);
      if (closer?.eventType === "tool.response") {
        attrs.json("gen_ai.tool.call.result", field(closer.output, "result") ?? null);
      }
      if (error?.code) attrs.set("error.type", error.code);
      return {
        name: `execute_tool ${tool}`,
        kind: SPAN_KIND_INTERNAL,
        attrs,
        failed: error !== null,
      };
    }
    case "agent.started": {
      const agent = str(field(opener.input, "agent")) ?? opener.name ?? agentSlug;
      attrs.set("gen_ai.operation.name", "invoke_agent").set("gen_ai.agent.name", agent);
      attrs.json("shadow.agent.request", field(opener.input, "request"));
      attrs.json("shadow.agent.outcome", closer ? field(closer.output, "outcome") : undefined);
      return {
        name: `invoke_agent ${agent}`,
        kind: SPAN_KIND_INTERNAL,
        attrs,
        failed: error !== null,
      };
    }
    default:
      attrs.json("shadow.event.input", opener.input).json("shadow.event.output", closer?.output);
      return { name: opener.name, kind: SPAN_KIND_INTERNAL, attrs, failed: error !== null };
  }
}

/** Closers are stamped when the operation ends, so a closer's time is its span's end. */
function endOf(event: ShadowEvent): string {
  return unixNanos(event.timestamp, event.sequence);
}

function maxNanos(values: string[]): string {
  return values.reduce((max, v) => (BigInt(v) > BigInt(max) ? v : max), "0");
}

/** Build the OTLP payload for every branch of an exported trace. */
export function exportTraceToOtlp(bundle: TraceExport): OtlpTracesPayload {
  const byBranch = new Map<string, ShadowEvent[]>();
  for (const event of bundle.events) {
    const list = byBranch.get(event.branchId) ?? [];
    list.push(event);
    byBranch.set(event.branchId, list);
  }
  const branches = new Map(bundle.branches.map((b) => [b.id, b]));
  const resource = new Attrs()
    .set("service.namespace", bundle.project.slug)
    .set("service.name", bundle.agent.slug)
    .set("shadow.trace.id", bundle.trace.id)
    .set("shadow.trace.name", bundle.trace.name)
    .set("shadow.trace.status", bundle.trace.status)
    .set("shadow.trace.tags", bundle.trace.tags)
    .set("shadow.schema_version", bundle.schemaVersion);

  const scopeSpans: OtlpSpan[] = [];
  for (const branch of bundle.branches) {
    const events = [...(byBranch.get(branch.id) ?? [])].sort((a, b) => a.sequence - b.sequence);
    scopeSpans.push(...branchSpans(bundle, branch, events, branches));
  }
  const resourceSpans: OtlpResourceSpans = {
    resource: { attributes: resource.list },
    scopeSpans: [
      {
        scope: { name: "@shadow/api", version: SCHEMA_VERSION },
        spans: scopeSpans,
      },
    ],
  };
  return { resourceSpans: [resourceSpans] };
}

function branchSpans(
  bundle: TraceExport,
  branch: Branch,
  events: ShadowEvent[],
  branches: Map<string, Branch>,
): OtlpSpan[] {
  const traceId = bundle.trace.id;
  const otelTraceId = otelTraceIdFor(traceId, branch.id);
  const rootSpanId = otelSpanIdFor(traceId, branch.id, "root");
  const { spans, loose } = groupSpans(events);
  const spanIds = new Map(spans.map((s) => [s.key, otelSpanIdFor(traceId, branch.id, s.key)]));
  const out: OtlpSpan[] = [];

  for (const span of spans) {
    const { name, kind, attrs, failed } = spanAttributes(span, bundle.agent.slug);
    eventAttrs(attrs, span.opener)
      .set("shadow.span.id", span.key)
      .set("shadow.branch.id", branch.id)
      .set("shadow.span.partial", span.partial ? true : undefined)
      .metadata(span.opener.metadata);
    const parentKey = span.opener.parentSpanId;
    const parentSpanId =
      parentKey !== null && spanIds.has(parentKey) ? spanIds.get(parentKey) : rootSpanId;
    const end = maxNanos([
      unixNanos(span.opener.timestamp, span.opener.sequence),
      ...(span.closer ? [endOf(span.closer)] : []),
      ...span.members.map(endOf),
    ]);
    const error = span.closer ? errorOf(span.closer) : null;
    out.push({
      traceId: otelTraceId,
      spanId: spanIds.get(span.key) ?? rootSpanId,
      ...(parentSpanId ? { parentSpanId } : {}),
      name,
      kind,
      startTimeUnixNano: unixNanos(span.opener.timestamp, span.opener.sequence),
      endTimeUnixNano: end,
      attributes: attrs.list,
      events: span.members.map(spanEventFrom),
      status: failed
        ? { code: STATUS_ERROR, ...(error ? { message: error.message } : {}) }
        : { code: STATUS_OK },
    });
  }

  const starts = events.map((e) => unixNanos(e.timestamp, e.sequence));
  const first = events[0];
  const start = first ? unixNanos(first.timestamp, first.sequence) : unixNanos(branch.createdAt);
  const end = maxNanos([
    start,
    ...starts,
    ...events.map(endOf),
    ...out.map((s) => String(s.endTimeUnixNano ?? "0")),
  ]);
  const rootAttrs = new Attrs()
    .set("gen_ai.operation.name", "invoke_agent")
    .set("gen_ai.agent.name", bundle.agent.slug)
    .set("shadow.trace.id", traceId)
    .set("shadow.branch.id", branch.id)
    .set("shadow.branch.name", branch.name)
    .set("shadow.branch.status", branch.status)
    .set("shadow.branch.depth", branch.depth)
    .json("shadow.branch.outcome", branch.outcome ? toJson(branch.outcome) : undefined)
    .set("shadow.branch.metrics.total_estimated_cost", branch.metrics.totalEstimatedCost)
    .metadata(branch.metadata);
  const links: OtlpSpanLink[] = [];
  if (branch.parentBranchId && branches.has(branch.parentBranchId)) {
    const fork = bundle.forks.find((f) => f.childBranchId === branch.id);
    links.push({
      traceId: otelTraceIdFor(traceId, branch.parentBranchId),
      spanId: otelSpanIdFor(traceId, branch.parentBranchId, "root"),
      attributes: new Attrs()
        .set("shadow.link", "forked_from")
        .set("shadow.fork.event_id", branch.forkEventId ?? undefined)
        .set("shadow.fork.sequence", branch.forkSequence ?? undefined)
        .json("shadow.fork.overrides", fork?.overrides).list,
    });
  }
  out.unshift({
    traceId: otelTraceId,
    spanId: rootSpanId,
    name: `invoke_agent ${bundle.agent.slug}`,
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: start,
    endTimeUnixNano: end,
    attributes: rootAttrs.list,
    events: loose.map(spanEventFrom),
    links,
    status: branch.status === "failed" ? { code: STATUS_ERROR } : { code: STATUS_OK },
  });
  return out;
}
