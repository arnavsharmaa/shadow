import { sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { branches, events, traces } from "../../db/schema.js";

/** Prometheus scrape endpoint; protected by the bearer token when one is configured. */
export const metricsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get("/metrics", { schema: { tags: ["health"], hide: true } }, async (_request, reply) => {
    const db = app.services.handle.db;
    const count = async (table: typeof traces | typeof events | typeof branches) => {
      const [row] = await db.select({ count: sql<number>`count(*)` }).from(table);
      return Number(row?.count ?? 0);
    };
    const [traceCount, branchCount, eventCount] = await Promise.all([
      count(traces),
      count(branches),
      count(events),
    ]);
    const body = app.services.metrics.render([
      { name: "shadow_traces", help: "Traces stored.", value: traceCount },
      { name: "shadow_branches", help: "Branches stored.", value: branchCount },
      { name: "shadow_events", help: "Events stored.", value: eventCount },
      {
        name: "shadow_replayable_agents",
        help: "Agents with a registered program.",
        value: app.services.registry.list().length,
      },
    ]);
    return reply.header("content-type", "text/plain; version=0.0.4; charset=utf-8").send(body);
  });
};
