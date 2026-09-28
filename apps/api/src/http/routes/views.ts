import { idSchema, saveViewBodySchema } from "@shadow/schemas";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { deleteView, getViewByName, listViews, saveView } from "../../services/views.js";
import { audit } from "../audit.js";

const viewParams = z.object({ viewId: idSchema });
const viewNameQuery = z.object({ name: z.string().min(1).max(64).optional() });

/** Team saved views: explorer filter sets stored on the server. */
export const viewRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get("/views", { schema: { tags: ["views"], querystring: viewNameQuery } }, async (request) =>
    request.query.name
      ? { items: [await getViewByName(app.services, request.query.name)] }
      : { items: await listViews(app.services) },
  );

  app.post(
    "/views",
    { schema: { tags: ["views"], body: saveViewBodySchema } },
    async (request, reply) => {
      const { view, created } = await saveView(app.services, request.body);
      await audit(app, request, {
        action: "view.saved",
        targetType: "view",
        targetId: view.id,
        details: { name: view.name, query: view.query, created },
      });
      return reply.status(created ? 201 : 200).send(view);
    },
  );

  app.delete(
    "/views/:viewId",
    { schema: { tags: ["views"], params: viewParams } },
    async (request, reply) => {
      await deleteView(app.services, request.params.viewId);
      await audit(app, request, {
        action: "view.deleted",
        targetType: "view",
        targetId: request.params.viewId,
      });
      return reply.status(204).send();
    },
  );
};
