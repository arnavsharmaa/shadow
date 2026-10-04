import { createApiKeyBodySchema } from "@shadow/schemas";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { createApiKey, listApiKeys, revokeApiKey } from "../../services/keys.js";
import { audit } from "../audit.js";

const params = z.object({ key: z.string().min(1).max(64) });

/** API keys. Managing them needs the API token or an admin key (enforced by the auth hook). */
export const keyRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get("/keys", { schema: { tags: ["keys"] } }, async () => ({
    items: await listApiKeys(app.services),
  }));

  app.post(
    "/keys",
    { schema: { tags: ["keys"], body: createApiKeyBodySchema } },
    async (request, reply) => {
      const { key, secret } = await createApiKey(app.services, request.body);
      await audit(app, request, {
        action: "key.created",
        targetType: "key",
        targetId: key.id,
        details: { name: key.name, scope: key.scope, prefix: key.prefix },
      });
      return reply.status(201).send({ key, secret });
    },
  );

  app.delete("/keys/:key", { schema: { tags: ["keys"], params } }, async (request) => {
    const key = await revokeApiKey(app.services, request.params.key);
    await audit(app, request, {
      action: "key.revoked",
      targetType: "key",
      targetId: key.id,
      details: { name: key.name, scope: key.scope },
    });
    return key;
  });
};
