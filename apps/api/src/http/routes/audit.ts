import { auditListQuerySchema } from "@shadow/schemas";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { listAudit } from "../../services/audit.js";

/** The audit log: who forked, replayed, deleted, pruned or imported what. */
export const auditRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/audit",
    { schema: { tags: ["audit"], querystring: auditListQuerySchema } },
    async (request) => listAudit(app.services, request.query),
  );
};
