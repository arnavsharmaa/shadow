import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { API_VERSION } from "../app.js";

const healthSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  version: z.string(),
  uptimeSeconds: z.number(),
  database: z.object({ kind: z.string(), location: z.string(), healthy: z.boolean() }),
});

export const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  const started = Date.now();
  app.get(
    "/health",
    { schema: { tags: ["health"], response: { 200: healthSchema, 503: healthSchema } } },
    async (_request, reply) => {
      const healthy = await app.services.handle.ping();
      const body = {
        status: healthy ? ("ok" as const) : ("degraded" as const),
        version: API_VERSION,
        uptimeSeconds: Math.round((Date.now() - started) / 1000),
        database: {
          kind: app.services.handle.kind,
          location: app.services.handle.location,
          healthy,
        },
      };
      return reply.status(healthy ? 200 : 503).send(body);
    },
  );
};
