import { ingestEventsBodySchema, type IngestEventInput } from "@shadow/schemas";
import { and, eq, inArray } from "drizzle-orm";
import type { Logger } from "pino";
import { events, traces } from "../db/schema.js";
import { ApiError } from "../errors.js";
import type { ServiceContext } from "../services/context.js";
import { ingestEvents } from "../services/events.js";
import { createTrace } from "../services/traces.js";
import {
  bufferedPayload,
  MAX_BUFFERED_SPANS,
  mergeBufferedSpans,
  rootSpanEnded,
  splitOtlpPayload,
  type BufferedOtlpTrace,
} from "./buffer.js";
import {
  convertOtlpTraces,
  OTEL_SEMCONV,
  type ConvertedTrace,
  type OtlpTracesPayload,
} from "./convert.js";

export interface OtlpImportedTrace {
  traceId: string;
  otelTraceId: string;
  /** False when spans were appended to a trace imported by an earlier request. */
  created: boolean;
  /** Events written; spans already stored (retried exports) are skipped. */
  accepted: number;
  skipped: number;
  /**
   * Spans held back (`SHADOW_OTLP_BUFFER_SECONDS`) until the trace's root span ends or the
   * window passes; nothing of the trace is stored yet while this is above zero.
   */
  buffered: number;
}

export interface OtlpImportResult {
  traces: OtlpImportedTrace[];
}

/** Why held spans were stored; the label of `shadow_otlp_buffer_flushes_total`. */
export type OtlpBufferFlushReason = "complete" | "expired" | "full" | "shutdown";

/**
 * Store an OTLP traces export. Each OpenTelemetry trace becomes (or extends) one
 * Shadow trace; re-sent spans are ignored by id, and spans that arrive after the
 * first request are appended without a second lifecycle and flagged `otel.late`.
 * With buffering on, the spans of a trace whose root span has not ended yet are held
 * (per process, in memory) and stored together with the batch that ends the root span, so
 * the whole trace gets one consistent ordering; the window, a full buffer or shutdown store
 * what is held as it is.
 */
export async function importOtlpTraces(
  ctx: ServiceContext,
  payload: OtlpTracesPayload,
  options: { defaultProject: string; onlyProject?: string },
): Promise<OtlpImportResult> {
  const converted = convertOtlpTraces(payload, { defaultProject: options.defaultProject });
  const foreign = options.onlyProject
    ? converted.filter((trace) => trace.project !== options.onlyProject)
    : [];
  if (foreign.length > 0) {
    throw new ApiError(
      403,
      "forbidden",
      `this API key is pinned to project '${options.onlyProject}'; the export names '${foreign[0]?.project}'`,
      { projects: [...new Set(foreign.map((t) => t.project))] },
    );
  }
  const result: OtlpImportResult = { traces: [] };
  ctx.metrics.otlpRequests.inc();
  const buffer = ctx.otlpBuffer;
  const fragments = buffer.enabled
    ? splitOtlpPayload(payload, options.defaultProject, ctx.clock.now())
    : new Map<string, BufferedOtlpTrace>();
  for (const trace of converted) {
    const existing = await isStored(ctx, trace.traceId);
    const fragment = fragments.get(trace.otelTraceId);
    if (existing || !fragment) {
      result.traces.push(await store(ctx, trace, existing));
      continue;
    }
    const held = buffer.take(trace.otelTraceId);
    const merged = mergeBufferedSpans(held, fragment);
    if (!rootSpanEnded(merged.spans) && merged.spans.length <= MAX_BUFFERED_SPANS) {
      const evicted = buffer.hold(merged);
      if (evicted) result.traces.push(await storeHeld(ctx, evicted, "full"));
      result.traces.push({
        traceId: trace.traceId,
        otelTraceId: trace.otelTraceId,
        created: false,
        accepted: 0,
        skipped: 0,
        buffered: merged.spans.length,
      });
      continue;
    }
    if (held) {
      result.traces.push(await storeHeld(ctx, merged, "complete"));
    } else {
      result.traces.push(await store(ctx, trace, existing));
    }
  }
  return result;
}

/** Store the held traces whose window has passed (or every held trace at shutdown). */
export async function flushOtlpBuffer(
  ctx: ServiceContext,
  options: { all?: boolean } = {},
): Promise<OtlpImportedTrace[]> {
  const out: OtlpImportedTrace[] = [];
  for (const held of ctx.otlpBuffer.drain(options.all ? undefined : ctx.clock.now())) {
    try {
      out.push(await storeHeld(ctx, held, options.all ? "shutdown" : "expired"));
    } catch (error) {
      ctx.logger.error(
        { err: error, otelTraceId: held.otelTraceId, spans: held.spans.length },
        "storing held OTLP spans failed",
      );
    }
  }
  return out;
}

export interface OtlpBufferFlusher {
  enabled: boolean;
  start(): void;
  /** Stops the timer and stores everything still held. */
  stop(): Promise<void>;
}

/**
 * Stores held traces whose window has passed, checking at most every 30 seconds. Nothing runs
 * when buffering is off.
 */
export function createOtlpBufferFlusher(input: {
  services: ServiceContext;
  logger: Logger;
}): OtlpBufferFlusher {
  const { services, logger } = input;
  const buffer = services.otlpBuffer;
  let timer: ReturnType<typeof setInterval> | null = null;
  let running: Promise<unknown> | null = null;
  const tick = (): Promise<unknown> => {
    running ??= flushOtlpBuffer(services)
      .catch((error: unknown) => {
        logger.error({ err: error }, "flushing held OTLP spans failed");
      })
      .finally(() => {
        running = null;
      });
    return running;
  };
  return {
    enabled: buffer.enabled,
    start() {
      if (!buffer.enabled || timer) return;
      timer = setInterval(() => void tick(), Math.min(buffer.windowMs, 30_000));
      timer.unref();
      logger.info({ windowSeconds: buffer.windowMs / 1000 }, "otlp buffering enabled");
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await running;
      const stored = await flushOtlpBuffer(services, { all: true });
      if (stored.length > 0) logger.info({ traces: stored.length }, "stored held OTLP traces");
    },
  };
}

async function isStored(ctx: ServiceContext, traceId: string): Promise<boolean> {
  const [existing] = await ctx.handle.db
    .select({ id: traces.id })
    .from(traces)
    .where(eq(traces.id, traceId))
    .limit(1);
  return existing !== undefined;
}

async function storeHeld(
  ctx: ServiceContext,
  held: BufferedOtlpTrace,
  reason: OtlpBufferFlushReason,
): Promise<OtlpImportedTrace> {
  const [trace] = convertOtlpTraces(bufferedPayload(held), {
    defaultProject: held.defaultProject,
  });
  if (!trace) throw new Error(`held OTLP trace ${held.otelTraceId} converts to nothing`);
  ctx.metrics.otlpBufferFlushes.inc({ reason });
  if (reason !== "complete") {
    ctx.logger.info(
      { otelTraceId: held.otelTraceId, spans: held.spans.length, reason },
      "storing held OTLP spans",
    );
  }
  // The trace may have been stored by another request while this one was held.
  return store(ctx, trace, await isStored(ctx, trace.traceId));
}

async function store(
  ctx: ServiceContext,
  trace: ConvertedTrace,
  existing: boolean,
): Promise<OtlpImportedTrace> {
  let batch: IngestEventInput[] = trace.events;
  if (!existing) {
    await createTrace(
      ctx,
      {
        id: trace.traceId,
        project: trace.project,
        agent: trace.agent,
        name: trace.name,
        startedAt: trace.startedAt,
        tags: ["otel"],
        metadata: { otel: { traceId: trace.otelTraceId, semconv: OTEL_SEMCONV } },
      },
      { source: "otlp" },
    );
  } else {
    batch = batch
      .filter((e) => !e.eventType.startsWith("trace.") && !e.id?.includes("_agent_"))
      .map((e) => ({
        ...e,
        metadata: { ...(e.metadata ?? {}), otel: { ...otelMeta(e), late: true } },
      }));
  }
  const ids = batch.map((e) => e.id).filter((id): id is string => typeof id === "string");
  const stored =
    ids.length > 0
      ? await ctx.handle.db
          .select({ id: events.id })
          .from(events)
          .where(and(eq(events.traceId, trace.traceId), inArray(events.id, ids)))
      : [];
  const seen = new Set(stored.map((row) => row.id));
  const fresh = batch.filter((e) => !e.id || !seen.has(e.id));
  if (fresh.length > 0) {
    const body = ingestEventsBodySchema.safeParse({ events: fresh });
    if (!body.success) {
      throw ApiError.badRequest(
        `OTLP trace ${trace.otelTraceId} maps to invalid events`,
        body.error.issues,
      );
    }
    await ingestEvents(ctx, trace.traceId, body.data);
  }
  return {
    traceId: trace.traceId,
    otelTraceId: trace.otelTraceId,
    created: !existing,
    accepted: fresh.length,
    skipped: batch.length - fresh.length,
    buffered: 0,
  };
}

function otelMeta(event: IngestEventInput): Record<string, unknown> {
  const otel = (event.metadata as Record<string, unknown> | undefined)?.otel;
  return otel && typeof otel === "object" && !Array.isArray(otel)
    ? (otel as Record<string, unknown>)
    : {};
}
