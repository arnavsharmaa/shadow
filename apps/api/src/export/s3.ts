import type { Logger } from "pino";
import type { ApiConfig } from "../config.js";
import type { ServiceContext } from "../services/context.js";
import { exportTrace } from "../services/transfer.js";
import { safePathComponent, type FileExporter } from "./file.js";
import { sha256Hex, signS3Request, uriEncode } from "./sigv4.js";

export interface S3ExporterOptions {
  config: Pick<
    ApiConfig,
    | "SHADOW_EXPORT_S3_BUCKET"
    | "SHADOW_EXPORT_S3_ENDPOINT"
    | "SHADOW_EXPORT_S3_REGION"
    | "SHADOW_EXPORT_S3_PREFIX"
    | "SHADOW_EXPORT_S3_ACCESS_KEY_ID"
    | "SHADOW_EXPORT_S3_SECRET_ACCESS_KEY"
    | "SHADOW_EXPORT_S3_SESSION_TOKEN"
  >;
  logger: Logger;
  fetch?: typeof fetch;
  /** Attempts per trace (default 3, exponential backoff from 250 ms). */
  maxAttempts?: number;
  backoffMs?: number;
  /** Clock for the request timestamp (tests pin it). */
  now?: () => Date;
}

/** Writes to object storage with the same contract as the file exporter. */
export type S3Exporter = FileExporter;

/** Where the bucket lives: an explicit endpoint, or the regional AWS one. */
export function s3Endpoint(
  config: Pick<ApiConfig, "SHADOW_EXPORT_S3_ENDPOINT" | "SHADOW_EXPORT_S3_REGION">,
): string {
  return (
    config.SHADOW_EXPORT_S3_ENDPOINT ?? `https://s3.${config.SHADOW_EXPORT_S3_REGION}.amazonaws.com`
  ).replace(/\/+$/, "");
}

/** The object key for a trace: `<prefix>/<project slug>/<traceId>.json`. */
export function s3ObjectKey(prefix: string | undefined, project: string, traceId: string): string {
  const folder = `${safePathComponent(project)}/${safePathComponent(traceId)}.json`;
  return prefix ? `${prefix}/${folder}` : folder;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Uploads every finished trace as a self-contained bundle to an S3-compatible bucket
 * (AWS S3, MinIO, Cloudflare R2, Ceph and the like) with path-style addressing and
 * Signature Version 4, so an archive or another Shadow instance can read it back. Like the
 * file exporter, uploads run off the ingestion path: failures are logged, retried and
 * counted, never surfaced to the client that sent the events.
 */
export function createS3Exporter(options: S3ExporterOptions): S3Exporter {
  const { config } = options;
  const bucket = config.SHADOW_EXPORT_S3_BUCKET;
  const accessKeyId = config.SHADOW_EXPORT_S3_ACCESS_KEY_ID;
  const secretAccessKey = config.SHADOW_EXPORT_S3_SECRET_ACCESS_KEY;
  const enabled = Boolean(bucket && accessKeyId && secretAccessKey);
  const endpoint = s3Endpoint(config);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const backoffMs = options.backoffMs ?? 250;
  const now = options.now ?? (() => new Date());
  const inflight = new Set<Promise<void>>();

  const upload = async (ctx: ServiceContext, traceId: string): Promise<void> => {
    if (!bucket || !accessKeyId || !secretAccessKey) return;
    let body: string;
    let key: string;
    try {
      const bundle = await exportTrace(ctx, traceId);
      body = JSON.stringify(bundle);
      key = s3ObjectKey(config.SHADOW_EXPORT_S3_PREFIX, bundle.project.slug, traceId);
    } catch (error) {
      options.logger.error({ traceId, err: error }, "trace bundle export failed");
      ctx.metrics.s3Exports.inc({ result: "export_failed" });
      return;
    }
    const url = new URL(
      `${endpoint}/${uriEncode(bucket)}/${key.split("/").map(uriEncode).join("/")}`,
    );
    const payloadHash = sha256Hex(body);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const headers = signS3Request({
          method: "PUT",
          url,
          headers: { "content-type": "application/json" },
          payloadHash,
          region: config.SHADOW_EXPORT_S3_REGION,
          accessKeyId,
          secretAccessKey,
          sessionToken: config.SHADOW_EXPORT_S3_SESSION_TOKEN,
          date: now(),
        });
        const response = await fetchImpl(url, { method: "PUT", headers, body });
        if (response.ok) {
          options.logger.debug({ traceId, bucket, key }, "trace bundle uploaded");
          ctx.metrics.s3Exports.inc({ result: "written" });
          return;
        }
        const text = (await response.text()).slice(0, 500);
        if (response.status < 500) {
          // Credentials, permissions or a missing bucket: retrying will not help.
          options.logger.error(
            { traceId, bucket, key, status: response.status, body: text },
            "object storage rejected the trace bundle",
          );
          ctx.metrics.s3Exports.inc({ result: "rejected" });
          return;
        }
        options.logger.warn(
          { traceId, bucket, key, status: response.status, attempt },
          "object storage upload failed",
        );
      } catch (error) {
        options.logger.warn(
          { traceId, bucket, key, attempt, err: error },
          "object storage upload failed",
        );
      }
      if (attempt < maxAttempts) await sleep(backoffMs * 2 ** (attempt - 1));
    }
    options.logger.error(
      { traceId, bucket, key, attempts: maxAttempts },
      "trace bundle upload gave up",
    );
    ctx.metrics.s3Exports.inc({ result: "failed" });
  };

  return {
    enabled,
    async traceFinished(ctx, traceId) {
      if (!enabled) return;
      const task = upload(ctx, traceId).finally(() => inflight.delete(task));
      inflight.add(task);
      await task;
    },
    async settle() {
      await Promise.allSettled([...inflight]);
    },
  };
}
