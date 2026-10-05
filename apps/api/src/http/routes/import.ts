import { importAnthropicBodySchema } from "@shadow/schemas";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { importAnthropicMessages } from "../../importers/import-anthropic.js";
import { audit } from "../audit.js";
import { ApiError } from "../../errors.js";
import { projectOf } from "../project-scope.js";

/** Importers for conversation logs recorded outside Shadow. */
export const importRoutes: FastifyPluginAsyncZod = async (app) => {
  /** A stored Anthropic Messages API conversation (see docs/integrations/anthropic.md). */
  app.post(
    "/import/anthropic",
    { schema: { tags: ["transfer"], body: importAnthropicBodySchema } },
    async (request, reply) => {
      // A key pinned to a project imports into that project and nowhere else.
      const pinned = projectOf(request);
      if (pinned && request.body.project && request.body.project !== pinned) {
        throw new ApiError(
          403,
          "forbidden",
          `this API key is pinned to project '${pinned}' and cannot record into '${request.body.project}'`,
        );
      }
      const result = await importAnthropicMessages(app.services, {
        ...request.body,
        project: request.body.project ?? pinned ?? undefined,
      });
      await audit(app, request, {
        action: "trace.imported",
        targetType: "trace",
        targetId: result.traceId,
        traceId: result.traceId,
        details: { format: "anthropic.messages", name: result.name, turns: result.summary.turns },
      });
      return reply.status(201).send(result);
    },
  );
};
