import { ingestEventsBodySchema, type IngestEventInput } from "@shadow/schemas";
import { and, eq, inArray } from "drizzle-orm";
import { events, traces } from "../db/schema.js";
import { ApiError } from "../errors.js";
import type { ServiceContext } from "../services/context.js";
import { ingestEvents } from "../services/events.js";
import { createTrace } from "../services/traces.js";
import { convertOtlpTraces, OTEL_SEMCONV, type OtlpTracesPayload } from "./convert.js";

export interface OtlpImportedTrace {
  traceId: string;
  otelTraceId: string;
  /** False when spans were appended to a trace imported by an earlier request. */
  created: boolean;
  /** Events written; spans already stored (retried exports) are skipped. */
  accepted: number;
  skipped: number;
}

export interface OtlpImportResult {
  traces: OtlpImportedTrace[];
}

/**
 * Store an OTLP traces export. Each OpenTelemetry trace becomes (or extends) one
 * Shadow trace; re-sent spans are ignored by id, and spans that arrive after the
 * first request are appended without a second lifecycle and flagged `otel.late`.
 */
export async function importOtlpTraces(
  ctx: ServiceContext,
  payload: OtlpTracesPayload,
  options: { defaultProject: string },
): Promise<OtlpImportResult> {
  const converted = convertOtlpTraces(payload, options);
  const result: OtlpImportResult = { traces: [] };
  for (const trace of converted) {
    const [existing] = await ctx.handle.db
      .select({ id: traces.id })
      .from(traces)
      .where(eq(traces.id, trace.traceId))
      .limit(1);
    let batch: IngestEventInput[] = trace.events;
    if (!existing) {
      await createTrace(ctx, {
        id: trace.traceId,
        project: trace.project,
        agent: trace.agent,
        name: trace.name,
        startedAt: trace.startedAt,
        tags: ["otel"],
        metadata: { otel: { traceId: trace.otelTraceId, semconv: OTEL_SEMCONV } },
      });
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
    result.traces.push({
      traceId: trace.traceId,
      otelTraceId: trace.otelTraceId,
      created: !existing,
      accepted: fresh.length,
      skipped: batch.length - fresh.length,
    });
  }
  return result;
}

function otelMeta(event: IngestEventInput): Record<string, unknown> {
  const otel = (event.metadata as Record<string, unknown> | undefined)?.otel;
  return otel && typeof otel === "object" && !Array.isArray(otel)
    ? (otel as Record<string, unknown>)
    : {};
}
