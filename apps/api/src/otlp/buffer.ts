import type { OtlpKeyValue, OtlpSpan, OtlpTracesPayload } from "./convert.js";

/** Spans of one OpenTelemetry trace waiting for their root span to end. */
export interface BufferedOtlpTrace {
  otelTraceId: string;
  /** Project fallback of the request that first delivered the trace. */
  defaultProject: string;
  resource: OtlpKeyValue[] | undefined;
  scope: { name?: string; version?: string } | undefined;
  spans: OtlpSpan[];
  /** `clock.now()` when the first spans arrived; the window counts from here. */
  firstSeenAt: number;
}

/** Traces held at once; beyond this the oldest is stored as it is. */
export const MAX_BUFFERED_TRACES = 1_000;
/** Spans held for one trace; beyond this the trace is stored as it is. */
export const MAX_BUFFERED_SPANS = 5_000;

/**
 * Holds the spans of OpenTelemetry traces that are still running (no root span has ended
 * yet) so that a trace exported across several batches is stored in one ordered pass instead
 * of a first batch plus late appends. In memory and per process: a restart stores nothing
 * that was held, so the window should stay short.
 */
export interface OtlpBuffer {
  enabled: boolean;
  /** How long a trace is held after its first spans, in milliseconds (0 = not at all). */
  windowMs: number;
  readonly size: number;
  /** Remove and return what is held for the trace. */
  take(otelTraceId: string): BufferedOtlpTrace | undefined;
  /** Hold a trace; returns the oldest held trace when there is no room for one more. */
  hold(trace: BufferedOtlpTrace): BufferedOtlpTrace | undefined;
  /** Remove and return the traces whose window has passed at `now` (all of them when omitted). */
  drain(now?: number): BufferedOtlpTrace[];
}

export function createOtlpBuffer(options: { windowSeconds: number }): OtlpBuffer {
  const windowMs = Math.max(0, options.windowSeconds) * 1000;
  const held = new Map<string, BufferedOtlpTrace>();
  return {
    enabled: windowMs > 0,
    windowMs,
    get size() {
      return held.size;
    },
    take(otelTraceId) {
      const entry = held.get(otelTraceId);
      if (entry) held.delete(otelTraceId);
      return entry;
    },
    hold(trace) {
      let evicted: BufferedOtlpTrace | undefined;
      if (!held.has(trace.otelTraceId) && held.size >= MAX_BUFFERED_TRACES) {
        for (const entry of held.values()) {
          if (!evicted || entry.firstSeenAt < evicted.firstSeenAt) evicted = entry;
        }
        if (evicted) held.delete(evicted.otelTraceId);
      }
      held.set(trace.otelTraceId, trace);
      return evicted;
    },
    drain(now) {
      const due = [...held.values()].filter(
        (entry) => now === undefined || entry.firstSeenAt + windowMs <= now,
      );
      for (const entry of due) held.delete(entry.otelTraceId);
      return due;
    },
  };
}

/** Split a request into one fragment per OpenTelemetry trace, keeping each trace's resource. */
export function splitOtlpPayload(
  payload: OtlpTracesPayload,
  defaultProject: string,
  now: number,
): Map<string, BufferedOtlpTrace> {
  const out = new Map<string, BufferedOtlpTrace>();
  for (const resourceSpans of payload.resourceSpans ?? []) {
    for (const scopeSpans of resourceSpans.scopeSpans ?? []) {
      for (const span of scopeSpans.spans ?? []) {
        if (typeof span?.traceId !== "string" || typeof span.spanId !== "string") continue;
        const fragment = out.get(span.traceId) ?? {
          otelTraceId: span.traceId,
          defaultProject,
          resource: resourceSpans.resource?.attributes,
          scope: scopeSpans.scope,
          spans: [],
          firstSeenAt: now,
        };
        fragment.spans.push(span);
        out.set(span.traceId, fragment);
      }
    }
  }
  return out;
}

/** Merge newly arrived spans into what is held; a re-sent span (same id) keeps its first copy. */
export function mergeBufferedSpans(
  held: BufferedOtlpTrace | undefined,
  incoming: BufferedOtlpTrace,
): BufferedOtlpTrace {
  if (!held) return incoming;
  const seen = new Set(held.spans.map((span) => span.spanId));
  return {
    ...held,
    spans: [...held.spans, ...incoming.spans.filter((span) => !seen.has(span.spanId))],
  };
}

/** The request shape the converter reads, rebuilt from a held trace. */
export function bufferedPayload(trace: BufferedOtlpTrace): OtlpTracesPayload {
  return {
    resourceSpans: [
      {
        ...(trace.resource ? { resource: { attributes: trace.resource } } : {}),
        scopeSpans: [{ ...(trace.scope ? { scope: trace.scope } : {}), spans: trace.spans }],
      },
    ],
  };
}

/**
 * Whether a span without a parent has ended. Only that closes a trace for buffering purposes:
 * a batch of children whose parent is still running has ended spans but is not complete.
 */
export function rootSpanEnded(spans: readonly OtlpSpan[]): boolean {
  return spans.some(
    (span) =>
      !span.parentSpanId &&
      span.endTimeUnixNano !== undefined &&
      span.endTimeUnixNano !== null &&
      span.endTimeUnixNano !== "",
  );
}
