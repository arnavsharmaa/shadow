import {
  builtinPricingProvider,
  randomIdGenerator,
  systemClock,
  type CatalogPricingProvider,
  type Clock,
  type IdGenerator,
  type Redactor,
} from "@shadow/core";
import type { Logger } from "pino";
import type { DatabaseHandle } from "../db/client.js";
import { ShadowMetrics } from "../metrics/registry.js";
import { noopWebhook, type Webhook } from "../notify/webhook.js";
import type { FileExporter } from "../export/file.js";
import type { S3Exporter } from "../export/s3.js";
import type { OtlpForwarder } from "../otlp/forwarder.js";
import { createOtlpBuffer, type OtlpBuffer } from "../otlp/buffer.js";
import { createJobRunner, type JobRunner } from "../jobs/runner.js";
import type { AgentRegistry } from "../replay/registry.js";

/** Dependencies shared by every service function. */
export interface ServiceContext {
  handle: DatabaseHandle;
  logger: Logger;
  registry: AgentRegistry;
  ids: IdGenerator;
  clock: Clock;
  redactor: Redactor;
  /** Process-wide counters rendered by GET /metrics. */
  metrics: ShadowMetrics;
  /** Outgoing notifications for finished traces. */
  webhook: Webhook;
  /** Forwarding of finished traces to an OTLP collector. */
  otlpForwarder: OtlpForwarder;
  /** Spans of OTLP traces held until their root span ends (`SHADOW_OTLP_BUFFER_SECONDS`). */
  otlpBuffer: OtlpBuffer;
  /** Writing of finished traces as bundles to a directory. */
  fileExporter: FileExporter;
  /** Uploading of finished traces as bundles to an S3-compatible bucket. */
  s3Exporter: S3Exporter;
  /** Background jobs (large batch counterfactuals), one at a time. */
  jobs: JobRunner;
  /** Price table used to estimate costs for events that arrive without one. */
  pricing: CatalogPricingProvider;
}

/** A forwarder that does nothing; used when no collector is configured and in tests. */
export const noopOtlpForwarder: OtlpForwarder = {
  enabled: false,
  traceFinished: async () => undefined,
  settle: async () => undefined,
};

/** A buffer that holds nothing; used when no window is configured and in tests. */
export const noopOtlpBuffer: OtlpBuffer = createOtlpBuffer({ windowSeconds: 0 });

/** An exporter that does nothing; used when no directory is configured and in tests. */
export const noopFileExporter: FileExporter = {
  enabled: false,
  traceFinished: async () => undefined,
  settle: async () => undefined,
};

/** An uploader that does nothing; used when no bucket is configured and in tests. */
export const noopS3Exporter: S3Exporter = {
  enabled: false,
  traceFinished: async () => undefined,
  settle: async () => undefined,
};

export function createServiceContext(
  input: Pick<ServiceContext, "handle" | "logger" | "registry" | "redactor"> &
    Partial<
      Pick<
        ServiceContext,
        | "ids"
        | "clock"
        | "metrics"
        | "webhook"
        | "otlpForwarder"
        | "otlpBuffer"
        | "fileExporter"
        | "s3Exporter"
        | "jobs"
        | "pricing"
      >
    >,
): ServiceContext {
  return {
    ...input,
    ids: input.ids ?? randomIdGenerator(),
    clock: input.clock ?? systemClock,
    metrics: input.metrics ?? new ShadowMetrics(),
    webhook: input.webhook ?? noopWebhook,
    otlpForwarder: input.otlpForwarder ?? noopOtlpForwarder,
    otlpBuffer: input.otlpBuffer ?? noopOtlpBuffer,
    fileExporter: input.fileExporter ?? noopFileExporter,
    s3Exporter: input.s3Exporter ?? noopS3Exporter,
    pricing: input.pricing ?? builtinPricingProvider,
    jobs:
      input.jobs ??
      createJobRunner((jobId, error) => input.logger.error({ jobId, err: error }, "job crashed")),
  };
}

export function encodeCursor(sequence: number): string {
  return Buffer.from(JSON.stringify({ s: sequence }), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return -1;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { s?: unknown };
    if (typeof parsed.s === "number" && Number.isInteger(parsed.s)) return parsed.s;
  } catch {
    // fall through
  }
  throw new Error("invalid cursor");
}

export const INSERT_CHUNK = 500;

export function chunk<T>(items: readonly T[], size = INSERT_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
