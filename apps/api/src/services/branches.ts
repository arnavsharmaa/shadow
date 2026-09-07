import {
  ForkError,
  ReplayError,
  createFork,
  createReplay,
  effectiveEvents,
  executeReplay,
} from "@shadow/core";
import type {
  Branch,
  CreateForkBody,
  Fork,
  JsonObject,
  Replay,
  ReplayMode,
  ShadowEvent,
} from "@shadow/schemas";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { branches, events, forks, replays, stateSnapshots, traces } from "../db/schema.js";
import { ApiError } from "../errors.js";
import { chunk, type ServiceContext } from "./context.js";
import {
  getBranchRow,
  insertSnapshots,
  lineageChain,
  listBranches,
  loadOwnEvents,
  recomputeBranchMetrics,
  updateSearchText,
} from "./events.js";
import { iso, toBranch, toEventRow, toFork, toReplay, type ForkRow } from "./mappers.js";
import { getTraceRow, getTraceSummary } from "./traces.js";

export async function getBranch(ctx: ServiceContext, branchId: string): Promise<Branch> {
  return toBranch(await getBranchRow(ctx, branchId));
}

export async function getForkRow(ctx: ServiceContext, forkId: string): Promise<ForkRow> {
  const [row] = await ctx.handle.db.select().from(forks).where(eq(forks.id, forkId)).limit(1);
  if (!row) throw ApiError.notFound("fork", forkId);
  return row;
}

export async function listForks(ctx: ServiceContext, traceId: string): Promise<Fork[]> {
  const rows = await ctx.handle.db
    .select()
    .from(forks)
    .where(eq(forks.traceId, traceId))
    .orderBy(asc(forks.createdAt));
  return rows.map(toFork);
}

export async function listReplays(ctx: ServiceContext, traceId: string): Promise<Replay[]> {
  const rows = await ctx.handle.db
    .select()
    .from(replays)
    .where(eq(replays.traceId, traceId))
    .orderBy(asc(replays.startedAt));
  return rows.map(toReplay);
}

export async function updateBranch(
  ctx: ServiceContext,
  branchId: string,
  patch: { name?: string; metadata?: JsonObject },
): Promise<Branch> {
  await getBranchRow(ctx, branchId);
  const set: Partial<typeof branches.$inferInsert> = { updatedAt: iso(new Date(ctx.clock.now())) };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.metadata !== undefined) set.metadata = patch.metadata;
  await ctx.handle.db.update(branches).set(set).where(eq(branches.id, branchId));
  return getBranch(ctx, branchId);
}

/** Delete a forked branch and all of its descendants. */
export async function deleteBranch(
  ctx: ServiceContext,
  branchId: string,
): Promise<{ deleted: string[] }> {
  const row = await getBranchRow(ctx, branchId);
  const trace = await getTraceRow(ctx, row.traceId);
  if (trace.rootBranchId === branchId)
    throw ApiError.unprocessable("root_branch", "the root branch cannot be deleted");
  const all = await listBranches(ctx, row.traceId);
  const toDelete = new Set<string>([branchId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const b of all) {
      if (b.parentBranchId && toDelete.has(b.parentBranchId) && !toDelete.has(b.id)) {
        toDelete.add(b.id);
        grew = true;
      }
    }
  }
  const ids = [...toDelete];
  await ctx.handle.db.transaction(async (tx) => {
    await tx.delete(forks).where(inArray(forks.childBranchId, ids));
    await tx.delete(branches).where(inArray(branches.id, ids));
    await tx
      .update(traces)
      .set({ branchCount: all.length - ids.length, updatedAt: iso(new Date(ctx.clock.now())) })
      .where(eq(traces.id, row.traceId));
  });
  return { deleted: ids };
}

/** Create a child branch diverging before `forkEventId`, with overrides. */
export async function createForkForTrace(
  ctx: ServiceContext,
  traceId: string,
  body: CreateForkBody,
): Promise<{ branch: Branch; fork: Fork }> {
  const trace = await getTraceRow(ctx, traceId);
  let parentBranchId = body.parentBranchId;
  if (!parentBranchId) {
    const [eventRow] = await ctx.handle.db
      .select({ branchId: events.branchId })
      .from(events)
      .where(and(eq(events.traceId, traceId), eq(events.id, body.forkEventId)))
      .limit(1);
    if (!eventRow) throw ApiError.notFound("event", body.forkEventId);
    parentBranchId = eventRow.branchId;
  }
  const { all, chain } = await lineageChain(ctx, parentBranchId);
  const parent = chain[chain.length - 1] as Branch;
  if (parent.traceId !== traceId)
    throw ApiError.badRequest(`branch ${parentBranchId} does not belong to trace ${traceId}`);
  const own = new Map<string, ShadowEvent[]>();
  for (const b of chain) own.set(b.id, await loadOwnEvents(ctx, b.id));
  const lineage = effectiveEvents(all, parent.id, (id) => own.get(id) ?? []);
  let created;
  try {
    created = createFork({
      trace: { id: traceId },
      parentBranch: parent,
      lineage,
      existingBranches: all,
      forkEventId: body.forkEventId,
      overrides: body.overrides,
      name: body.name,
      metadata: body.metadata,
      ids: ctx.ids,
      clock: ctx.clock,
    });
  } catch (error) {
    if (error instanceof ForkError) {
      if (error.code === "event_not_found") throw ApiError.notFound("event", body.forkEventId);
      throw ApiError.unprocessable("not_forkable", error.message);
    }
    throw error;
  }
  if (all.some((b) => b.name === created.branch.name)) {
    throw ApiError.conflict(`a branch named '${created.branch.name}' already exists`, {
      name: created.branch.name,
    });
  }
  await ctx.handle.db.transaction(async (tx) => {
    await tx.insert(branches).values({
      id: created.branch.id,
      traceId,
      name: created.branch.name,
      parentBranchId: created.branch.parentBranchId,
      forkId: created.branch.forkId,
      forkEventId: created.branch.forkEventId,
      forkSequence: created.branch.forkSequence,
      depth: created.branch.depth,
      status: created.branch.status,
      outcome: null,
      metrics: created.branch.metrics,
      metadata: created.branch.metadata,
      createdAt: created.branch.createdAt,
      updatedAt: created.branch.updatedAt,
    });
    await tx.insert(forks).values({
      id: created.fork.id,
      traceId,
      parentBranchId: created.fork.parentBranchId,
      childBranchId: created.fork.childBranchId,
      forkEventId: created.fork.forkEventId,
      forkSequence: created.fork.forkSequence,
      overrides: created.fork.overrides,
      metadata: created.fork.metadata,
      createdAt: created.fork.createdAt,
    });
    await tx.insert(events).values(created.events.map(toEventRow));
    await tx
      .update(traces)
      .set({ branchCount: all.length + 1, updatedAt: iso(new Date(ctx.clock.now())) })
      .where(eq(traces.id, trace.id));
  });
  return { branch: created.branch, fork: created.fork };
}

/** Execute a deterministic replay of a forked branch and persist its events. */
export async function runReplay(
  ctx: ServiceContext,
  branchId: string,
  mode: ReplayMode,
): Promise<{ replay: Replay; branch: Branch }> {
  const branchRow = await getBranchRow(ctx, branchId);
  const branch = toBranch(branchRow);
  if (!branch.parentBranchId || !branch.forkId || branch.forkSequence == null) {
    throw ApiError.unprocessable(
      "not_forked",
      "only forked branches can be replayed; fork a branch first",
    );
  }
  if (mode === "historical") {
    throw ApiError.unprocessable(
      "unsupported_mode",
      "historical replay is served by the events endpoint; nothing is executed",
    );
  }
  if (mode === "live") {
    throw new ApiError(
      501,
      "live_replay_disabled",
      "live re-execution against real models/tools is not enabled in this release (see docs/concepts/replay-modes.md)",
    );
  }
  const summary = await getTraceSummary(ctx, branch.traceId);
  const definition = ctx.registry.get(summary.agentSlug);
  if (!definition) {
    throw ApiError.unprocessable(
      "agent_not_replayable",
      `no replayable program is registered for agent '${summary.agentSlug}'; deterministic replay requires the agent program (see docs/concepts/replay-modes.md)`,
      { agent: summary.agentSlug, replayable: ctx.registry.list().map((d) => d.slug) },
    );
  }
  const fork = toFork(await getForkRow(ctx, branch.forkId));
  const { all, chain } = await lineageChain(ctx, branch.parentBranchId);
  const own = new Map<string, ShadowEvent[]>();
  for (const b of chain) own.set(b.id, await loadOwnEvents(ctx, b.id));
  const parentLineage = effectiveEvents(all, branch.parentBranchId, (id) => own.get(id) ?? []);
  const inherited: Fork["overrides"] = [];
  for (const ancestor of chain) {
    if (ancestor.forkId)
      inherited.push(...toFork(await getForkRow(ctx, ancestor.forkId)).overrides);
  }

  const now = iso(new Date(ctx.clock.now()));
  const replayId = ctx.ids.next("rpl");
  // Discard any previous replay output (keeps the fork.created event).
  await ctx.handle.db.transaction(async (tx) => {
    await tx
      .delete(events)
      .where(and(eq(events.branchId, branchId), gt(events.sequence, fork.forkSequence + 1)));
    await tx.delete(stateSnapshots).where(eq(stateSnapshots.branchId, branchId));
    await tx
      .update(branches)
      .set({ status: "replaying", updatedAt: now })
      .where(eq(branches.id, branchId));
    await tx.insert(replays).values({
      id: replayId,
      traceId: branch.traceId,
      branchId,
      forkId: branch.forkId,
      mode,
      status: "running",
      startedAt: now,
      metadata: { agent: definition.slug },
    });
  });
  const existing = await loadOwnEvents(ctx, branchId);
  let plan;
  try {
    plan = createReplay({
      trace: { id: branch.traceId },
      branch,
      fork,
      parentLineage,
      existingBranchEvents: existing,
      inheritedOverrides: inherited,
      mode,
      replayId,
    });
  } catch (error) {
    if (error instanceof ReplayError)
      throw ApiError.unprocessable(error.code, error.message, error.details);
    throw error;
  }
  const log = ctx.logger.child({
    replayId,
    branchId,
    traceId: branch.traceId,
    agent: definition.slug,
  });
  log.info("replay started");
  const outcome = await executeReplay(plan, definition);
  const completedAt = iso(new Date(ctx.clock.now()));
  await ctx.handle.db.transaction(async (tx) => {
    for (const part of chunk(outcome.events)) await tx.insert(events).values(part.map(toEventRow));
    await insertSnapshots(tx, outcome.events);
    await tx
      .update(replays)
      .set({
        status: outcome.status,
        completedAt,
        eventCount: outcome.events.length,
        error: outcome.error,
      })
      .where(eq(replays.id, replayId));
    await tx
      .update(branches)
      .set({ status: outcome.branchStatus, outcome: outcome.outcome, updatedAt: completedAt })
      .where(eq(branches.id, branchId));
  });
  if (outcome.status === "failed") log.error({ error: outcome.error }, "replay failed");
  else
    log.info({ events: outcome.events.length, outcome: outcome.outcome?.kind }, "replay completed");
  const updated = await recomputeBranchMetrics(ctx, branchId);
  await updateSearchText(ctx, await getTraceRow(ctx, branch.traceId), outcome.events);
  const [replayRow] = await ctx.handle.db
    .select()
    .from(replays)
    .where(eq(replays.id, replayId))
    .limit(1);
  return { replay: toReplay(replayRow as typeof replays.$inferSelect), branch: updated };
}
