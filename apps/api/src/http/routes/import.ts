import { importAnthropicBodySchema } from "@shadow/schemas";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { importAnthropicMessages } from "../../importers/import-anthropic.js";
import { audit } from "../audit.js";

/** Importers for conversation logs recorded outside Shadow. */
export const importRoutes: FastifyPluginAsyncZod = async (app) => {
  /** A stored Anthropic Messages API conversation (see docs/integrations/anthropic.md). */
  app.post(
    "/import/anthropic",
    { schema: { tags: ["transfer"], body: importAnthropicBodySchema } },
    async (request, reply) => {
      const result = await importAnthropicMessages(app.services, request.body);
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
