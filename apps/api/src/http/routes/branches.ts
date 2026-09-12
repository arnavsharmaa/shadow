import {
  branchStateQuerySchema,
  eventListQuerySchema,
  idSchema,
  replayRequestBodySchema,
  updateBranchBodySchema,
} from "@shadow/schemas";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { deleteBranch, getBranch, runReplay, updateBranch } from "../../services/branches.js";
import { getBranchState, pageEvents } from "../../services/events.js";

const params = z.object({ branchId: idSchema });

export const branchRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get("/branches/:branchId", { schema: { tags: ["branches"], params } }, async (request) =>
    getBranch(app.services, request.params.branchId),
  );

  app.patch(
    "/branches/:branchId",
    { schema: { tags: ["branches"], params, body: updateBranchBodySchema } },
    async (request) => updateBranch(app.services, request.params.branchId, request.body),
  );

  app.delete("/branches/:branchId", { schema: { tags: ["branches"], params } }, async (request) =>
    deleteBranch(app.services, request.params.branchId),
  );

  app.get(
    "/branches/:branchId/events",
    {
      schema: {
        tags: ["events"],
        params,
        querystring: eventListQuerySchema.omit({ branchId: true, inherited: true }),
      },
    },
    async (request) => {
      const branch = await getBranch(app.services, request.params.branchId);
      return pageEvents(app.services, branch.traceId, {
        ...request.query,
        branchId: branch.id,
        inherited: true,
      });
    },
  );

  app.get(
    "/branches/:branchId/state",
    { schema: { tags: ["branches"], params, querystring: branchStateQuerySchema } },
    async (request) => getBranchState(app.services, request.params.branchId, request.query),
  );

  app.post(
    "/branches/:branchId/replay",
    // Fastify hands a body-less POST to the validator as `null`, so `.optional()` alone rejects it.
    { schema: { tags: ["replays"], params, body: replayRequestBodySchema.nullish() } },
    async (request, reply) => {
      const result = await runReplay(
        app.services,
        request.params.branchId,
        request.body?.mode ?? "deterministic",
      );
      return reply.status(201).send(result);
    },
  );
};
