import { createProjectBodySchema } from "@shadow/schemas";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { createProject, listAgents, listProjects } from "../../services/projects.js";

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
};
