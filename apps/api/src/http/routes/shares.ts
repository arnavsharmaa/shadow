import { createShareBodySchema, idSchema } from "@shadow/schemas";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { createShare, listShares, openShare, revokeShare } from "../../services/shares.js";
import { audit } from "../audit.js";

const traceParams = z.object({ traceId: idSchema });
const shareParams = z.object({ traceId: idSchema, shareId: idSchema });
const tokenParams = z.object({ token: z.string().min(1).max(128) });

/** Share links. `GET /shared/:token` is the one API route that needs no bearer token. */
export const shareRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    "/traces/:traceId/shares",
    { schema: { tags: ["sharing"], params: traceParams, body: createShareBodySchema.nullish() } },
    async (request, reply) => {
      const body = createShareBodySchema.parse(request.body ?? {});
      const { share, token } = await createShare(app.services, request.params.traceId, body);
      await audit(app, request, {
        action: "share.created",
        targetType: "trace",
        targetId: share.traceId,
        traceId: share.traceId,
        details: { shareId: share.id, expiresAt: share.expiresAt, note: share.note },
      });
      return reply.status(201).send({ share, token, path: `/api/v1/shared/${token}` });
    },
  );

  app.get(
    "/traces/:traceId/shares",
    { schema: { tags: ["sharing"], params: traceParams } },
    async (request) => ({ items: await listShares(app.services, request.params.traceId) }),
  );

  app.delete(
    "/traces/:traceId/shares/:shareId",
    { schema: { tags: ["sharing"], params: shareParams } },
    async (request) => {
      const share = await revokeShare(app.services, request.params.traceId, request.params.shareId);
      await audit(app, request, {
        action: "share.revoked",
        targetType: "trace",
        targetId: share.traceId,
        traceId: share.traceId,
        details: { shareId: share.id, accessCount: share.accessCount },
      });
      return share;
    },
  );

  app.get(
    "/shared/:token",
    { schema: { tags: ["sharing"], params: tokenParams } },
    async (request, reply) => {
      const bundle = await openShare(app.services, request.params.token);
      reply.header("cache-control", "private, no-store");
      reply.header("content-disposition", `attachment; filename="${bundle.trace.id}.shadow.json"`);
      return bundle;
    },
  );
};
