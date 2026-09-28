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
import { audit } from "../audit.js";

const params = z.object({ branchId: idSchema });

export const branchRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get("/branches/:branchId", { schema: { tags: ["branches"], params } }, async (request) =>
    getBranch(app.services, request.params.branchId),
  );

  app.patch(
    "/branches/:branchId",
    { schema: { tags: ["branches"], params, body: updateBranchBodySchema } },
    async (request) => {
      const branch = await updateBranch(app.services, request.params.branchId, request.body);
      await audit(app, request, {
        action: "branch.updated",
        targetType: "branch",
        targetId: branch.id,
        traceId: branch.traceId,
        details: { changes: request.body },
      });
      return branch;
    },
  );

  app.delete("/branches/:branchId", { schema: { tags: ["branches"], params } }, async (request) => {
    const branch = await getBranch(app.services, request.params.branchId);
    const result = await deleteBranch(app.services, branch.id);
    await audit(app, request, {
      action: "branch.deleted",
      targetType: "branch",
      targetId: branch.id,
      traceId: branch.traceId,
      details: { name: branch.name, deleted: result.deleted },
    });
    return result;
  });

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
      await audit(app, request, {
        action: "replay.run",
        targetType: "branch",
        targetId: result.branch.id,
        traceId: result.branch.traceId,
        details: {
          replayId: result.replay.id,
          mode: result.replay.mode,
          status: result.replay.status,
        },
      });
      return reply.status(201).send(result);
    },
  );
};
