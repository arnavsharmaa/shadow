import {
  collectionListQuerySchema,
  collectionTracesBodySchema,
  createCollectionBodySchema,
  idSchema,
  updateCollectionBodySchema,
} from "@shadow/schemas";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  addTraces,
  createCollection,
  deleteCollection,
  getCollection,
  listCollections,
  removeTrace,
  updateCollection,
} from "../../services/collections.js";
import { audit } from "../audit.js";

/** `:collection` is a collection id (`col_…`) or its name. */
const params = z.object({ collection: z.string().min(1).max(128) });
const traceParams = params.extend({ traceId: idSchema });

/** Trace collections: named groups such as incidents, experiments or review queues. */
export const collectionRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/collections",
    { schema: { tags: ["collections"], querystring: collectionListQuerySchema } },
    async (request) => ({ items: await listCollections(app.services, request.query) }),
  );

  app.post(
    "/collections",
    { schema: { tags: ["collections"], body: createCollectionBodySchema } },
    async (request, reply) => {
      const result = await createCollection(app.services, request.body);
      await audit(app, request, {
        action: "collection.created",
        targetType: "collection",
        targetId: result.collection.id,
        details: { name: result.collection.name, added: result.added.length },
      });
      return reply.status(201).send(result);
    },
  );

  app.get(
    "/collections/:collection",
    { schema: { tags: ["collections"], params } },
    async (request) => getCollection(app.services, request.params.collection),
  );

  app.patch(
    "/collections/:collection",
    { schema: { tags: ["collections"], params, body: updateCollectionBodySchema } },
    async (request) => {
      const collection = await updateCollection(
        app.services,
        request.params.collection,
        request.body,
      );
      await audit(app, request, {
        action: "collection.updated",
        targetType: "collection",
        targetId: collection.id,
        details: { name: collection.name, changes: request.body },
      });
      return collection;
    },
  );

  app.delete(
    "/collections/:collection",
    { schema: { tags: ["collections"], params } },
    async (request, reply) => {
      const collection = await deleteCollection(app.services, request.params.collection);
      await audit(app, request, {
        action: "collection.deleted",
        targetType: "collection",
        targetId: collection.id,
        details: { name: collection.name, traceCount: collection.traceCount },
      });
      return reply.status(204).send();
    },
  );

  app.post(
    "/collections/:collection/traces",
    { schema: { tags: ["collections"], params, body: collectionTracesBodySchema } },
    async (request) => {
      const result = await addTraces(
        app.services,
        request.params.collection,
        request.body.traceIds,
      );
      const collection = await getCollection(app.services, request.params.collection);
      if (result.added.length > 0) {
        await audit(app, request, {
          action: "collection.traces_added",
          targetType: "collection",
          targetId: collection.id,
          details: { name: collection.name, traceIds: result.added.slice(0, 100) },
        });
      }
      return { collection, ...result };
    },
  );

  app.delete(
    "/collections/:collection/traces/:traceId",
    { schema: { tags: ["collections"], params: traceParams } },
    async (request) => {
      const collection = await removeTrace(
        app.services,
        request.params.collection,
        request.params.traceId,
      );
      await audit(app, request, {
        action: "collection.traces_removed",
        targetType: "collection",
        targetId: collection.id,
        traceId: request.params.traceId,
        details: { name: collection.name },
      });
      return collection;
    },
  );
};
