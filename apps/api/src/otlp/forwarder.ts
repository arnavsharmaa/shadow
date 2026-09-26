import type { Logger } from "pino";
import type { ApiConfig } from "../config.js";
import type { ServiceContext } from "../services/context.js";
import { exportTrace } from "../services/transfer.js";
import { exportTraceToOtlp } from "./export.js";
import { encodeOtlpProtobuf } from "./protobuf.js";

export interface OtlpForwarderOptions {
  config: Pick<
    ApiConfig,
    "SHADOW_OTLP_EXPORT_URL" | "SHADOW_OTLP_EXPORT_HEADERS" | "SHADOW_OTLP_EXPORT_ENCODING"
  >;
  logger: Logger;
  fetch?: typeof fetch;
  /** Attempts per trace (default 3, exponential backoff from 250 ms). */
  maxAttempts?: number;
  backoffMs?: number;
}

export interface OtlpForwarder {
  enabled: boolean;
  /** Export the trace and POST it to the collector; resolves after delivery. Never throws. */
  traceFinished(ctx: ServiceContext, traceId: string): Promise<void>;
  /** Outstanding deliveries, so shutdown can wait for them. */
  settle(): Promise<void>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Parse `SHADOW_OTLP_EXPORT_HEADERS`: `name=value` pairs separated by commas or newlines
 * (`authorization=Bearer abc, x-tenant=support`). Values may contain `=`.
 */
export function parseHeaderList(text: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const item of (text ?? "").split(/[,\n]/)) {
    const index = item.indexOf("=");
    if (index <= 0) continue;
    const name = item.slice(0, index).trim().toLowerCase();
    const value = item.slice(index + 1).trim();
    if (name && value) headers[name] = value;
  }
  return headers;
}

/**
 * Forwards finished traces to an OTLP/HTTP collector so Shadow can sit next to an existing
 * observability stack. Like the webhook, delivery is off the ingestion path: failures are
 * logged and retried, never surfaced to the client that sent the events.
 */
export function createOtlpForwarder(options: OtlpForwarderOptions): OtlpForwarder {
  const url = options.config.SHADOW_OTLP_EXPORT_URL;
  const encoding = options.config.SHADOW_OTLP_EXPORT_ENCODING;
  const extraHeaders = parseHeaderList(options.config.SHADOW_OTLP_EXPORT_HEADERS);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const backoffMs = options.backoffMs ?? 250;
  const inflight = new Set<Promise<void>>();

  const deliver = async (ctx: ServiceContext, traceId: string): Promise<void> => {
    if (!url) return;
    let body: Uint8Array<ArrayBuffer> | string;
    try {
      const payload = exportTraceToOtlp(await exportTrace(ctx, traceId));
      body =
        encoding === "protobuf"
          ? new Uint8Array(encodeOtlpProtobuf(payload))
          : JSON.stringify(payload);
    } catch (error) {
      options.logger.error({ traceId, err: error }, "otlp export failed");
      ctx.metrics.otlpExports.inc({ result: "export_failed" });
      return;
    }
    const headers: Record<string, string> = {
      ...extraHeaders,
      "content-type": encoding === "protobuf" ? "application/x-protobuf" : "application/json",
      "user-agent": "shadow-otlp-exporter",
    };
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await fetchImpl(url, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(15_000),
        });
        if (response.ok) {
          options.logger.debug({ traceId, attempt, bytes: body.length }, "otlp export delivered");
          ctx.metrics.otlpExports.inc({ result: "delivered" });
          return;
        }
        if (response.status < 500 && response.status !== 429) {
          options.logger.warn(
            { traceId, status: response.status },
            "otlp collector rejected the export; not retrying",
          );
          ctx.metrics.otlpExports.inc({ result: "rejected" });
          return;
        }
        options.logger.warn(
          { traceId, status: response.status, attempt },
          "otlp export delivery failed",
        );
      } catch (error) {
        options.logger.warn({ traceId, attempt, err: error }, "otlp export delivery failed");
      }
      if (attempt < maxAttempts) await sleep(backoffMs * 2 ** (attempt - 1));
    }
    options.logger.error({ traceId, url }, "otlp export gave up");
    ctx.metrics.otlpExports.inc({ result: "failed" });
  };

  return {
    enabled: url !== undefined,
    async traceFinished(ctx, traceId) {
      if (!url) return;
      const task = deliver(ctx, traceId).finally(() => inflight.delete(task));
      inflight.add(task);
      await task;
    },
    async settle() {
      await Promise.allSettled([...inflight]);
    },
  };
}
