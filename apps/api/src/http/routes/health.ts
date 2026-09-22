import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { ApiConfig } from "../../config.js";
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
    }),
    otlp: z.object({ path: z.string(), defaultProject: z.string() }),
    webhook: z.object({ enabled: z.boolean(), events: z.string().optional() }),
  }),
});

export interface HealthRouteOptions {
  config: Pick<
    ApiConfig,
    | "SHADOW_API_TOKEN"
    | "SHADOW_RETENTION_DAYS"
    | "SHADOW_RETENTION_INTERVAL_MINUTES"
    | "SHADOW_RETENTION_KEEP_TAG"
    | "SHADOW_OTLP_DEFAULT_PROJECT"
    | "SHADOW_WEBHOOK_URL"
    | "SHADOW_WEBHOOK_EVENTS"
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
            retentionDays === undefined
              ? { enabled: false }
              : {
                  enabled: true,
                  days: retentionDays,
                  intervalMinutes: config.SHADOW_RETENTION_INTERVAL_MINUTES,
                  ...(config.SHADOW_RETENTION_KEEP_TAG
                    ? { keepTag: config.SHADOW_RETENTION_KEEP_TAG }
                    : {}),
                },
          otlp: {
            path: "/api/v1/otlp/v1/traces",
            defaultProject: config.SHADOW_OTLP_DEFAULT_PROJECT,
          },
          webhook: config.SHADOW_WEBHOOK_URL
            ? { enabled: true, events: config.SHADOW_WEBHOOK_EVENTS }
            : { enabled: false },
        },
      };
      return reply.status(healthy ? 200 : 503).send(body);
    },
  );
};
