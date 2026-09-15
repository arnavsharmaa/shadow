import { createProjectBodySchema } from "@shadow/schemas";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { createProject, listAgents, listProjects } from "../../services/projects.js";
import { agentStats } from "../../services/stats.js";

const agentStatsQuerySchema = z.object({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  project: z.string().max(64).optional(),
});

export const projectRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get("/projects", { schema: { tags: ["projects"] } }, async () => ({
    items: await listProjects(app.services),
  }));

  app.post(
    "/projects",
    { schema: { tags: ["projects"], body: createProjectBodySchema } },
    async (request, reply) => {
      const project = await createProject(app.services, request.body);
      return reply.status(201).send(project);
    },
  );

  app.get(
    "/agents",
    { schema: { tags: ["projects"], querystring: z.object({ projectId: z.string().optional() }) } },
    async (request) => ({
      items: await listAgents(app.services, request.query.projectId),
      replayable: app.services.registry
        .list()
        .map((d) => ({ slug: d.slug, name: d.name, description: d.description ?? null })),
    }),
  );

  /** Per-agent volume, failure, policy-violation, latency, cost and token aggregates. */
  app.get(
    "/stats/agents",
    { schema: { tags: ["projects"], querystring: agentStatsQuerySchema } },
    async (request) => ({
      from: request.query.from ?? null,
      to: request.query.to ?? null,
      items: await agentStats(app.services, request.query),
    }),
  );
};
