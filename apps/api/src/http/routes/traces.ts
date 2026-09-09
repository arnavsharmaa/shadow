import { buildEventTree, diffJson, flattenTree } from "@shadow/core";
import {
  artifactListQuerySchema,
  createArtifactBodySchema,
  createForkBodySchema,
  createTraceBodySchema,
  eventListQuerySchema,
  idSchema,
  importTraceBodySchema,
  ingestEventsBodySchema,
  traceListQuerySchema,
} from "@shadow/schemas";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { createArtifact, getArtifact, listArtifacts } from "../../services/artifacts.js";
import { createForkForTrace, listForks, listReplays } from "../../services/branches.js";
import {
  getBranchState,
  getEvent,
  ingestEvents,
  listBranches,
  loadEffectiveEvents,
  pageEvents,
} from "../../services/events.js";
import {
  createTrace,
  deleteTrace,
  getTraceSummary,
  listTraces,
  traceFacets,
} from "../../services/traces.js";
import { exportTrace, importTrace } from "../../services/transfer.js";

const traceParams = z.object({ traceId: idSchema });
const eventParams = z.object({ traceId: idSchema, eventId: idSchema });

export const traceRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/traces",
    { schema: { tags: ["traces"], querystring: traceListQuerySchema } },
    async (request) => listTraces(app.services, request.query),
  );

  app.get("/traces/facets", { schema: { tags: ["traces"] } }, async () =>
    traceFacets(app.services),
  );

  app.post(
    "/traces",
    { schema: { tags: ["traces"], body: createTraceBodySchema } },
    async (request, reply) => {
      const trace = await createTrace(app.services, request.body);
      return reply.status(201).send(trace);
    },
  );

  app.post(
    "/traces/import",
    { schema: { tags: ["transfer"], body: importTraceBodySchema } },
    async (request, reply) => {
      const trace = await importTrace(app.services, request.body.bundle, request.body.idStrategy);
      return reply.status(201).send(trace);
    },
  );

  app.get(
    "/traces/:traceId",
    { schema: { tags: ["traces"], params: traceParams } },
    async (request) => {
      const trace = await getTraceSummary(app.services, request.params.traceId);
      const branches = await listBranches(app.services, trace.id);
      return { trace, branches };
    },
  );

  app.delete(
    "/traces/:traceId",
    { schema: { tags: ["traces"], params: traceParams } },
    async (request, reply) => {
      await deleteTrace(app.services, request.params.traceId);
      return reply.status(204).send();
    },
  );

  app.get(
    "/traces/:traceId/events",
    { schema: { tags: ["events"], params: traceParams, querystring: eventListQuerySchema } },
    async (request) => pageEvents(app.services, request.params.traceId, request.query),
  );

  app.post(
    "/traces/:traceId/events",
    { schema: { tags: ["events"], params: traceParams, body: ingestEventsBodySchema } },
    async (request, reply) => {
      const result = await ingestEvents(app.services, request.params.traceId, request.body);
      return reply.status(201).send({
        accepted: result.events.length,
        branch: result.branch,
        eventIds: result.events.map((e) => e.id),
      });
    },
  );

  /** Execution hierarchy for the branch (defaults to root), flattened depth-first. */
  app.get(
    "/traces/:traceId/tree",
    {
      schema: {
        tags: ["events"],
        params: traceParams,
        querystring: z.object({ branchId: idSchema.optional() }),
      },
    },
    async (request) => {
      const trace = await getTraceSummary(app.services, request.params.traceId);
      const branchId = request.query.branchId ?? trace.rootBranchId;
      const events = await loadEffectiveEvents(app.services, branchId);
      const nodes = flattenTree(buildEventTree(events)).map((n) => ({
        id: n.event.id,
        depth: n.depth,
        childCount: n.children.length,
        spanDurationMs: n.spanDurationMs,
      }));
      return { branchId, events, nodes };
    },
  );

  app.get(
    "/traces/:traceId/events/:eventId",
    { schema: { tags: ["events"], params: eventParams } },
    async (request) => getEvent(app.services, request.params.traceId, request.params.eventId),
  );

  /** State before/after an event plus the diff, as seen from a branch lineage. */
  app.get(
    "/traces/:traceId/events/:eventId/state",
    {
      schema: {
        tags: ["events"],
        params: eventParams,
        querystring: z.object({ branchId: idSchema.optional() }),
      },
    },
    async (request) => {
      const trace = await getTraceSummary(app.services, request.params.traceId);
      const event = await getEvent(app.services, trace.id, request.params.eventId);
      const branchId = request.query.branchId ?? event.branchId;
      const after = await getBranchState(app.services, branchId, { sequence: event.sequence });
      const before = await getBranchState(app.services, branchId, { sequence: event.sequence - 1 });
      return {
        event: { id: event.id, sequence: event.sequence },
        branchId,
        before,
        after,
        stateDiff: diffJson(before.state, after.state),
        contextDiff: diffJson(before.context, after.context),
      };
    },
  );

  app.get(
    "/traces/:traceId/branches",
    { schema: { tags: ["branches"], params: traceParams } },
    async (request) => {
      await getTraceSummary(app.services, request.params.traceId);
      return { items: await listBranches(app.services, request.params.traceId) };
    },
  );

  app.get(
    "/traces/:traceId/forks",
    { schema: { tags: ["forks"], params: traceParams } },
    async (request) => {
      await getTraceSummary(app.services, request.params.traceId);
      return { items: await listForks(app.services, request.params.traceId) };
    },
  );

  app.post(
    "/traces/:traceId/forks",
    { schema: { tags: ["forks"], params: traceParams, body: createForkBodySchema } },
    async (request, reply) => {
      const result = await createForkForTrace(app.services, request.params.traceId, request.body);
      return reply.status(201).send(result);
    },
  );

  app.get(
    "/traces/:traceId/replays",
    { schema: { tags: ["replays"], params: traceParams } },
    async (request) => {
      await getTraceSummary(app.services, request.params.traceId);
      return { items: await listReplays(app.services, request.params.traceId) };
    },
  );

  app.get(
    "/traces/:traceId/artifacts",
    { schema: { tags: ["artifacts"], params: traceParams, querystring: artifactListQuerySchema } },
    async (request) => ({
      items: await listArtifacts(app.services, request.params.traceId, request.query),
    }),
  );

  app.post(
    "/traces/:traceId/artifacts",
    { schema: { tags: ["artifacts"], params: traceParams, body: createArtifactBodySchema } },
    async (request, reply) => {
      const artifact = await createArtifact(app.services, request.params.traceId, request.body);
      return reply.status(201).send(artifact);
    },
  );

  app.get(
    "/traces/:traceId/artifacts/:artifactId",
    {
      schema: {
        tags: ["artifacts"],
        params: z.object({ traceId: idSchema, artifactId: idSchema }),
      },
    },
    async (request) => getArtifact(app.services, request.params.traceId, request.params.artifactId),
  );

  app.get(
    "/traces/:traceId/export",
    { schema: { tags: ["transfer"], params: traceParams } },
    async (request, reply) => {
      const bundle = await exportTrace(app.services, request.params.traceId);
      reply.header("content-disposition", `attachment; filename="${bundle.trace.id}.shadow.json"`);
      return bundle;
    },
  );
};
