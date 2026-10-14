import { comparisonListQuerySchema, createComparisonBodySchema, idSchema } from "@shadow/schemas";
import { comparisonReportMarkdown } from "@shadow/core";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { createComparison, getComparison, listComparisons } from "../../services/comparisons.js";
import { audit } from "../audit.js";

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
      await audit(app, request, {
        action: "comparison.created",
        targetType: "comparison",
        targetId: comparison.id,
        traceId: comparison.traceId,
        details: {
          baseBranchId: comparison.baseBranchId,
          targetBranchId: comparison.targetBranchId,
        },
      });
      return reply.status(201).send(comparison);
    },
  );

  app.get(
    "/comparisons/:comparisonId",
    {
      schema: {
        tags: ["comparisons"],
        params: z.object({ comparisonId: idSchema }),
        querystring: z.object({ format: z.enum(["json", "markdown"]).default("json") }),
      },
    },
    async (request, reply) => {
      const comparison = await getComparison(app.services, request.params.comparisonId);
      if (request.query.format === "markdown") {
        reply.header("content-type", "text/markdown; charset=utf-8");
        reply.header("content-disposition", `attachment; filename="${comparison.id}.md"`);
        return reply.send(comparisonReportMarkdown(comparison));
      }
      return comparison;
    },
  );
};
