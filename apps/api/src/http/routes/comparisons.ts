import { comparisonListQuerySchema, createComparisonBodySchema, idSchema } from "@shadow/schemas";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { createComparison, getComparison, listComparisons } from "../../services/comparisons.js";

export const comparisonRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/comparisons",
    { schema: { tags: ["comparisons"], querystring: comparisonListQuerySchema } },
    async (request) => listComparisons(app.services, request.query),
  );

  app.post(
    "/comparisons",
    { schema: { tags: ["comparisons"], body: createComparisonBodySchema } },
    async (request, reply) => {
      const comparison = await createComparison(app.services, request.body);
      return reply.status(201).send(comparison);
    },
  );

  app.get(
    "/comparisons/:comparisonId",
    { schema: { tags: ["comparisons"], params: z.object({ comparisonId: idSchema }) } },
    async (request) => getComparison(app.services, request.params.comparisonId),
  );
};
