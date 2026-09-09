import { BundleValidationError, parseBundle, regenerateBundleIds, sortEvents } from "@shadow/core";
import { SCHEMA_VERSION, type Trace, type TraceExport } from "@shadow/schemas";
import { asc, eq } from "drizzle-orm";
import {
  agents,
  artifacts,
  branches,
  comparisons,
  events,
  forks,
  projects,
  replays,
  traces,
} from "../db/schema.js";
import { ApiError } from "../errors.js";
import { chunk, type ServiceContext } from "./context.js";
import { insertSnapshots, recomputeBranchMetrics } from "./events.js";
import {
  iso,
  toArtifact,
  toBranch,
  toComparison,
  toEvent,
  toEventRow,
  toFork,
  toReplay,
  toTrace,
} from "./mappers.js";
import { ensureAgent, ensureProject } from "./projects.js";
import { likeSearchProvider } from "./search.js";
import { getTraceRow } from "./traces.js";

/** Build a self-contained, portable bundle for a trace. */
export async function exportTrace(ctx: ServiceContext, traceId: string): Promise<TraceExport> {
  const traceRow = await getTraceRow(ctx, traceId);
  const [project] = await ctx.handle.db
    .select()
    .from(projects)
    .where(eq(projects.id, traceRow.projectId))
    .limit(1);
  const [agent] = await ctx.handle.db
    .select()
    .from(agents)
    .where(eq(agents.id, traceRow.agentId))
    .limit(1);
  if (!project || !agent) throw ApiError.notFound("trace", traceId);
  const db = ctx.handle.db;
  const [branchRows, forkRows, replayRows, eventRows, comparisonRows, artifactRows] =
    await Promise.all([
      db
        .select()
        .from(branches)
        .where(eq(branches.traceId, traceId))
        .orderBy(asc(branches.createdAt)),
      db.select().from(forks).where(eq(forks.traceId, traceId)).orderBy(asc(forks.createdAt)),
      db.select().from(replays).where(eq(replays.traceId, traceId)).orderBy(asc(replays.startedAt)),
      db
        .select()
        .from(events)
        .where(eq(events.traceId, traceId))
        .orderBy(asc(events.branchId), asc(events.sequence)),
      db
        .select()
        .from(comparisons)
        .where(eq(comparisons.traceId, traceId))
        .orderBy(asc(comparisons.createdAt)),
      db
        .select()
        .from(artifacts)
        .where(eq(artifacts.traceId, traceId))
        .orderBy(asc(artifacts.createdAt), asc(artifacts.id)),
    ]);
  return {
    format: "shadow.trace",
    schemaVersion: SCHEMA_VERSION,
    exportedAt: iso(new Date(ctx.clock.now())),
    project: {
      slug: project.slug,
      name: project.name,
      description: project.description,
      metadata: (project.metadata as Trace["metadata"]) ?? {},
    },
    agent: {
      slug: agent.slug,
      name: agent.name,
      description: agent.description,
      metadata: (agent.metadata as Trace["metadata"]) ?? {},
    },
    trace: toTrace(traceRow),
    branches: branchRows.map(toBranch),
    forks: forkRows.map(toFork),
    replays: replayRows.map(toReplay),
    events: eventRows.map(toEvent),
    comparisons: comparisonRows.map(toComparison),
    artifacts: artifactRows.map(toArtifact),
  };
}

/** Import a bundle. Returns the (possibly re-identified) trace. */
export async function importTrace(
  ctx: ServiceContext,
  raw: unknown,
  idStrategy: "keep" | "regenerate",
): Promise<Trace> {
  let bundle: TraceExport;
  try {
    bundle = parseBundle(raw);
  } catch (error) {
    if (error instanceof BundleValidationError)
      throw ApiError.badRequest(error.message, error.issues);
    throw error;
  }
  if (idStrategy === "regenerate") {
    bundle = regenerateBundleIds(bundle, ctx.ids);
  } else {
    const [existing] = await ctx.handle.db
      .select({ id: traces.id })
      .from(traces)
      .where(eq(traces.id, bundle.trace.id))
      .limit(1);
    if (existing) {
      throw ApiError.conflict(
        `trace ${bundle.trace.id} already exists; import with idStrategy=regenerate to copy it`,
        { traceId: bundle.trace.id },
      );
    }
  }
  const project = await ensureProject(ctx, {
    slug: bundle.project.slug,
    name: bundle.project.name,
    description: bundle.project.description,
    metadata: bundle.project.metadata,
  });
  const agent = await ensureAgent(ctx, {
    projectId: project.id,
    slug: bundle.agent.slug,
    name: bundle.agent.name,
    description: bundle.agent.description,
    metadata: bundle.agent.metadata,
  });
  const now = iso(new Date(ctx.clock.now()));
  const sortedEvents = sortEvents(bundle.events);
  const searchText = likeSearchProvider.buildSearchText({
    trace: bundle.trace,
    agent,
    project,
    events: sortedEvents,
  });

  await ctx.handle.db.transaction(async (tx) => {
    await tx.insert(traces).values({
      id: bundle.trace.id,
      projectId: project.id,
      agentId: agent.id,
      rootBranchId: bundle.trace.rootBranchId,
      name: bundle.trace.name,
      status: bundle.trace.status,
      schemaVersion: bundle.trace.schemaVersion,
      startedAt: bundle.trace.startedAt,
      completedAt: bundle.trace.completedAt,
      durationMs: bundle.trace.durationMs,
      outcome: bundle.trace.outcome,
      tags: bundle.trace.tags,
      metadata: bundle.trace.metadata,
      metrics: bundle.trace.metrics,
      branchCount: bundle.branches.length,
      searchText,
      createdAt: now,
      updatedAt: now,
    });
    for (const branch of bundle.branches) {
      await tx.insert(branches).values({
        id: branch.id,
        traceId: bundle.trace.id,
        name: branch.name,
        parentBranchId: branch.parentBranchId,
        forkId: branch.forkId,
        forkEventId: branch.forkEventId,
        forkSequence: branch.forkSequence,
        depth: branch.depth,
        status: branch.status,
        outcome: branch.outcome,
        metrics: branch.metrics,
        metadata: branch.metadata,
        createdAt: branch.createdAt,
        updatedAt: branch.updatedAt,
      });
    }
    for (const part of chunk(sortedEvents))
      await tx
        .insert(events)
        .values(part.map((e) => toEventRow({ ...e, traceId: bundle.trace.id })));
    await insertSnapshots(tx, sortedEvents);
    for (const fork of bundle.forks) {
      await tx.insert(forks).values({ ...fork, traceId: bundle.trace.id });
    }
    for (const replay of bundle.replays) {
      await tx.insert(replays).values({ ...replay, traceId: bundle.trace.id });
    }
    for (const comparison of bundle.comparisons) {
      await tx.insert(comparisons).values({ ...comparison, traceId: bundle.trace.id });
    }
    for (const artifact of bundle.artifacts) {
      await tx.insert(artifacts).values({ ...artifact, traceId: bundle.trace.id });
    }
  });
  for (const branch of bundle.branches) await recomputeBranchMetrics(ctx, branch.id);
  return toTrace(await getTraceRow(ctx, bundle.trace.id));
}
