import { batchCounterfactualBodySchema } from "@shadow/schemas";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { runBatchCounterfactual } from "../../services/batch.js";

export const batchRoutes: FastifyPluginAsyncZod = async (app) => {
  /** Apply one override set to many recorded traces of an agent (see docs/architecture/api.md). */
  app.post(
    "/batch/counterfactuals",
    { schema: { tags: ["forks"], body: batchCounterfactualBodySchema } },
    async (request, reply) => {
      const result = await runBatchCounterfactual(app.services, request.body);
      return reply.status(201).send(result);
    },
  );
};
