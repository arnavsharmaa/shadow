import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { ApiConfig } from "../../config.js";
import { s3Endpoint } from "../../export/s3.js";
import { API_VERSION } from "../app.js";

const healthSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  version: z.string(),
  uptimeSeconds: z.number(),
  database: z.object({ kind: z.string(), location: z.string(), healthy: z.boolean() }),
  /** Agents with a registered program, i.e. forkable and replayable. */
  agents: z.object({ replayable: z.array(z.string()) }),
  features: z.object({
    /** Whether /api/* requires a bearer token. */
    auth: z.boolean(),
    retention: z.object({
      enabled: z.boolean(),
      days: z.number().optional(),
      intervalMinutes: z.number().optional(),
      keepTag: z.string().optional(),
      /** Projects with their own retention window, in days. */
      projects: z.record(z.string(), z.number()).optional(),
    }),
    sampling: z.object({ enabled: z.boolean(), rate: z.number() }),
    otlp: z.object({
      path: z.string(),
      defaultProject: z.string(),
      /** Seconds that spans of a running OTLP trace are held before they are stored. */
      bufferSeconds: z.number().optional(),
      export: z.object({ enabled: z.boolean(), encoding: z.string().optional() }),
    }),
    webhook: z.object({
      enabled: z.boolean(),
      events: z.string().optional(),
      format: z.string().optional(),
    }),
    /** Whether finished traces are written to a directory as bundles. */
    fileExport: z.object({ enabled: z.boolean(), dir: z.string().optional() }),
    /** Whether finished traces are uploaded to an S3-compatible bucket as bundles. */
    s3Export: z.object({
      enabled: z.boolean(),
      bucket: z.string().optional(),
      endpoint: z.string().optional(),
      prefix: z.string().optional(),
    }),
  }),
});

export interface HealthRouteOptions {
  config: Pick<
    ApiConfig,
    | "SHADOW_API_TOKEN"
    | "SHADOW_RETENTION_DAYS"
    | "SHADOW_RETENTION_INTERVAL_MINUTES"
    | "SHADOW_RETENTION_KEEP_TAG"
    | "SHADOW_RETENTION_PROJECT_DAYS"
    | "SHADOW_OTLP_DEFAULT_PROJECT"
    | "SHADOW_OTLP_BUFFER_SECONDS"
    | "SHADOW_INGEST_SAMPLE_RATE"
    | "SHADOW_OTLP_EXPORT_URL"
    | "SHADOW_OTLP_EXPORT_ENCODING"
    | "SHADOW_WEBHOOK_URL"
    | "SHADOW_WEBHOOK_EVENTS"
    | "SHADOW_WEBHOOK_FORMAT"
    | "SHADOW_EXPORT_DIR"
    | "SHADOW_EXPORT_S3_BUCKET"
    | "SHADOW_EXPORT_S3_ENDPOINT"
    | "SHADOW_EXPORT_S3_REGION"
    | "SHADOW_EXPORT_S3_PREFIX"
  >;
}

export const healthRoutes: FastifyPluginAsyncZod<HealthRouteOptions> = async (app, options) => {
  const started = Date.now();
  const { config } = options;
  app.get(
    "/health",
    { schema: { tags: ["health"], response: { 200: healthSchema, 503: healthSchema } } },
    async (_request, reply) => {
      const healthy = await app.services.handle.ping();
      const retentionDays = config.SHADOW_RETENTION_DAYS;
      const projectDays = Object.entries(config.SHADOW_RETENTION_PROJECT_DAYS ?? {});
      const body = {
        status: healthy ? ("ok" as const) : ("degraded" as const),
        version: API_VERSION,
        uptimeSeconds: Math.round((Date.now() - started) / 1000),
        database: {
          kind: app.services.handle.kind,
          location: app.services.handle.location,
          healthy,
        },
        agents: {
          replayable: app.services.registry
            .list()
            .map((d) => d.slug)
            .sort(),
        },
        features: {
          auth: config.SHADOW_API_TOKEN !== undefined,
          retention:
            retentionDays === undefined && projectDays.length === 0
              ? { enabled: false }
              : {
                  enabled: true,
                  ...(retentionDays !== undefined ? { days: retentionDays } : {}),
                  intervalMinutes: config.SHADOW_RETENTION_INTERVAL_MINUTES,
                  ...(config.SHADOW_RETENTION_KEEP_TAG
                    ? { keepTag: config.SHADOW_RETENTION_KEEP_TAG }
                    : {}),
                  ...(projectDays.length > 0 ? { projects: Object.fromEntries(projectDays) } : {}),
                },
          sampling: {
            enabled: config.SHADOW_INGEST_SAMPLE_RATE < 1,
            rate: config.SHADOW_INGEST_SAMPLE_RATE,
          },
          otlp: {
            path: "/api/v1/otlp/v1/traces",
            defaultProject: config.SHADOW_OTLP_DEFAULT_PROJECT,
            ...(config.SHADOW_OTLP_BUFFER_SECONDS > 0
              ? { bufferSeconds: config.SHADOW_OTLP_BUFFER_SECONDS }
              : {}),
            export: config.SHADOW_OTLP_EXPORT_URL
              ? { enabled: true, encoding: config.SHADOW_OTLP_EXPORT_ENCODING }
              : { enabled: false },
          },
          webhook: config.SHADOW_WEBHOOK_URL
            ? {
                enabled: true,
                events: config.SHADOW_WEBHOOK_EVENTS,
                format: config.SHADOW_WEBHOOK_FORMAT,
              }
            : { enabled: false },
          fileExport: config.SHADOW_EXPORT_DIR
            ? { enabled: true, dir: config.SHADOW_EXPORT_DIR }
            : { enabled: false },
          s3Export: app.services.s3Exporter.enabled
            ? {
                enabled: true,
                bucket: config.SHADOW_EXPORT_S3_BUCKET,
                endpoint: s3Endpoint(config),
                ...(config.SHADOW_EXPORT_S3_PREFIX
                  ? { prefix: config.SHADOW_EXPORT_S3_PREFIX }
                  : {}),
              }
            : { enabled: false },
        },
      };
      return reply.status(healthy ? 200 : 503).send(body);
    },
  );
};
