import { buildEventTree, diffJson, flattenTree } from "@shadow/core";
import {
  artifactListQuerySchema,
  createArtifactBodySchema,
  createForkBodySchema,
  createTraceBodySchema,
  forkMatrixBodySchema,
  eventListQuerySchema,
  idSchema,
  importTraceBodySchema,
  ingestEventsBodySchema,
  pruneTracesBodySchema,
  traceListQuerySchema,
  updateTraceBodySchema,
} from "@shadow/schemas";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { createArtifact, getArtifact, listArtifacts } from "../../services/artifacts.js";
import { createForkForTrace, listForks, listReplays } from "../../services/branches.js";
import { runForkMatrix } from "../../services/matrix.js";
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
  pruneTraces,
  traceFacets,
  updateTrace,
} from "../../services/traces.js";
import { exportTrace, importTrace } from "../../services/transfer.js";
import { audit } from "../audit.js";
import { exportTraceToOtlp } from "../../otlp/export.js";
import { encodeOtlpProtobuf } from "../../otlp/protobuf.js";

const traceParams = z.object({ traceId: idSchema });
/** `shadow` is the self-contained bundle; `otlp` is an OTLP ExportTraceServiceRequest. */
const exportQuerySchema = z.object({
  format: z.enum(["shadow", "otlp"]).default("shadow"),
  encoding: z.enum(["json", "protobuf"]).optional(),
});
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
      await audit(app, request, {
        action: "trace.imported",
        targetType: "trace",
        targetId: trace.id,
        traceId: trace.id,
        details: { idStrategy: request.body.idStrategy ?? null, name: trace.name },
      });
      return reply.status(201).send(trace);
    },
  );

  /** Retention: delete traces that started before a cutoff (see docs/architecture/api.md). */
  app.post(
    "/traces/prune",
    { schema: { tags: ["traces"], body: pruneTracesBodySchema } },
    async (request) => {
      const result = await pruneTraces(app.services, request.body);
      if (!result.dryRun && result.traceIds.length > 0) {
        await audit(app, request, {
          action: "traces.pruned",
          targetType: "trace",
          targetId: result.traceIds.length === 1 ? (result.traceIds[0] ?? "-") : "*",
          details: {
            before: request.body.before,
            deleted: result.traceIds.length,
            traceIds: result.traceIds.slice(0, 100),
            truncated: result.truncated,
          },
        });
      }
      return result;
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

  app.patch(
    "/traces/:traceId",
    { schema: { tags: ["traces"], params: traceParams, body: updateTraceBodySchema } },
    async (request) => {
      const trace = await updateTrace(app.services, request.params.traceId, request.body);
      await audit(app, request, {
        action: "trace.updated",
        targetType: "trace",
        targetId: trace.id,
        traceId: trace.id,
        details: { changes: request.body },
      });
      return trace;
    },
  );

  app.delete(
    "/traces/:traceId",
    { schema: { tags: ["traces"], params: traceParams } },
    async (request, reply) => {
      const trace = await getTraceSummary(app.services, request.params.traceId);
      await deleteTrace(app.services, trace.id);
      await audit(app, request, {
        action: "trace.deleted",
        targetType: "trace",
        targetId: trace.id,
        traceId: trace.id,
        details: { name: trace.name, agent: trace.agentSlug, project: trace.projectSlug },
      });
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
      await audit(app, request, {
        action: "fork.created",
        targetType: "branch",
        targetId: result.branch.id,
        traceId: result.branch.traceId,
        details: {
          name: result.branch.name,
          forkEventId: result.fork.forkEventId,
          parentBranchId: result.fork.parentBranchId,
          overrides: result.fork.overrides,
        },
      });
      return reply.status(201).send(result);
    },
  );

  /** Scenario matrix: fork the same event with several override sets, replay and compare each. */
  app.post(
    "/traces/:traceId/forks/matrix",
    { schema: { tags: ["forks"], params: traceParams, body: forkMatrixBodySchema } },
    async (request, reply) => {
      const result = await runForkMatrix(app.services, request.params.traceId, request.body);
      await audit(app, request, {
        action: "matrix.run",
        targetType: "trace",
        targetId: request.params.traceId,
        traceId: request.params.traceId,
        details: {
          forkEventId: request.body.forkEventId,
          branches: result.variants.map((v) => v.branch.id),
          changed: result.variants.filter((v) => v.outcome.changed).length,
        },
      });
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
      await audit(app, request, {
        action: "artifact.created",
        targetType: "artifact",
        targetId: artifact.id,
        traceId: artifact.traceId,
        details: { kind: artifact.kind, name: artifact.name, eventId: artifact.eventId },
      });
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
    { schema: { tags: ["transfer"], params: traceParams, querystring: exportQuerySchema } },
    async (request, reply) => {
      const bundle = await exportTrace(app.services, request.params.traceId);
      if (request.query.format === "otlp") {
        const payload = exportTraceToOtlp(bundle);
        const protobuf =
          request.query.encoding === "protobuf" ||
          (request.query.encoding === undefined &&
            (request.headers.accept ?? "").includes("application/x-protobuf"));
        if (protobuf) {
          reply.header("content-type", "application/x-protobuf");
          reply.header("content-disposition", `attachment; filename="${bundle.trace.id}.otlp.bin"`);
          return reply.send(Buffer.from(encodeOtlpProtobuf(payload)));
        }
        reply.header("content-disposition", `attachment; filename="${bundle.trace.id}.otlp.json"`);
        return payload;
      }
      reply.header("content-disposition", `attachment; filename="${bundle.trace.id}.shadow.json"`);
      return bundle;
    },
  );
};
