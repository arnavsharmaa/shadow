import {
  STATE_MUTATING_EVENT_TYPES,
  aggregateMetrics,
  mergeMetrics,
  deriveOutcome,
  effectiveEvents,
  reconstructState,
  resolveLineage,
  sortEvents,
} from "@shadow/core";
import {
  eventSchema,
  stateSnapshotPayloadSchema,
  type Branch,
  type BranchMetrics,
  type IngestEventsBody,
  type ReconstructedState,
  type ShadowEvent,
} from "@shadow/schemas";
import { and, asc, desc, eq, gt, ilike, inArray, lte, or, sql, type SQL } from "drizzle-orm";
import { agents, branches, events, projects, stateSnapshots, traces } from "../db/schema.js";
import { ApiError } from "../errors.js";
import { chunk, decodeCursor, encodeCursor, type ServiceContext } from "./context.js";
import {
  iso,
  toBranch,
  toEvent,
  toEventRow,
  toMetrics,
  type BranchRow,
  type EventRow,
  type TraceRow,
} from "./mappers.js";
import { likeSearchProvider } from "./search.js";
import { getTraceRow } from "./traces.js";

export async function getBranchRow(ctx: ServiceContext, branchId: string): Promise<BranchRow> {
  const [row] = await ctx.handle.db
    .select()
    .from(branches)
    .where(eq(branches.id, branchId))
    .limit(1);
  if (!row) throw ApiError.notFound("branch", branchId);
  return row;
}

export async function listBranches(ctx: ServiceContext, traceId: string): Promise<Branch[]> {
  const rows = await ctx.handle.db
    .select()
    .from(branches)
    .where(eq(branches.traceId, traceId))
    .orderBy(asc(branches.createdAt), asc(branches.id));
  return rows.map(toBranch);
}

/** Root-to-leaf chain for a branch. */
export async function lineageChain(
  ctx: ServiceContext,
  branchId: string,
): Promise<{ all: Branch[]; chain: Branch[] }> {
  const row = await getBranchRow(ctx, branchId);
  const all = await listBranches(ctx, row.traceId);
  return { all, chain: resolveLineage(all, branchId) };
}

/**
 * Highest sequence the branch at `index` contributes to the lineage: the
 * smallest fork point among its descendants in the chain (a grandchild may
 * fork from an event inherited from its grandparent). Mirrors `effectiveEvents`.
 */
function lineageCutoff(chain: readonly Branch[], index: number): number | null {
  let cutoff: number | null = null;
  for (let i = index + 1; i < chain.length; i++) {
    const forkSequence = chain[i]?.forkSequence;
    if (forkSequence != null && (cutoff === null || forkSequence < cutoff)) cutoff = forkSequence;
  }
  return cutoff;
}

/**
 * SQL predicate selecting the effective events of a lineage: every ancestor
 * contributes events up to the fork point of its descendants; the leaf contributes all.
 */
export function lineageCondition(chain: readonly Branch[]): SQL {
  const parts: SQL[] = [];
  for (let i = 0; i < chain.length; i++) {
    const branch = chain[i] as Branch;
    const cutoff = lineageCutoff(chain, i);
    if (cutoff !== null) {
      parts.push(and(eq(events.branchId, branch.id), lte(events.sequence, cutoff)) as SQL);
    } else {
      parts.push(eq(events.branchId, branch.id));
    }
  }
  return (parts.length === 1 ? parts[0] : or(...parts)) as SQL;
}

function snapshotLineageCondition(chain: readonly Branch[]): SQL {
  const parts: SQL[] = [];
  for (let i = 0; i < chain.length; i++) {
    const branch = chain[i] as Branch;
    const cutoff = lineageCutoff(chain, i);
    if (cutoff !== null) {
      parts.push(
        and(eq(stateSnapshots.branchId, branch.id), lte(stateSnapshots.sequence, cutoff)) as SQL,
      );
    } else {
      parts.push(eq(stateSnapshots.branchId, branch.id));
    }
  }
  return (parts.length === 1 ? parts[0] : or(...parts)) as SQL;
}

/** All effective events of a branch, sorted by sequence. */
export async function loadEffectiveEvents(
  ctx: ServiceContext,
  branchId: string,
): Promise<ShadowEvent[]> {
  const { chain } = await lineageChain(ctx, branchId);
  const rows = await ctx.handle.db
    .select()
    .from(events)
    .where(lineageCondition(chain))
    .orderBy(asc(events.sequence));
  return rows.map(toEvent);
}

export async function loadOwnEvents(ctx: ServiceContext, branchId: string): Promise<ShadowEvent[]> {
  const rows = await ctx.handle.db
    .select()
    .from(events)
    .where(eq(events.branchId, branchId))
    .orderBy(asc(events.sequence));
  return rows.map(toEvent);
}

export async function getEvent(
  ctx: ServiceContext,
  traceId: string,
  eventId: string,
): Promise<ShadowEvent> {
  const [row] = await ctx.handle.db
    .select()
    .from(events)
    .where(and(eq(events.traceId, traceId), eq(events.id, eventId)))
    .limit(1);
  if (!row) throw ApiError.notFound("event", eventId);
  return toEvent(row);
}

export interface EventPageQuery {
  branchId?: string;
  cursor?: string;
  limit: number;
  eventType?: string;
  name?: string;
  severity?: string;
  q?: string;
  inherited: boolean;
}

function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, (c) => `\\${c}`);
}

/** Cursor-paginated effective events of a branch (default: root). */
export async function pageEvents(ctx: ServiceContext, traceId: string, query: EventPageQuery) {
  const trace = await getTraceRow(ctx, traceId);
  const branchId = query.branchId ?? trace.rootBranchId;
  const { chain } = await lineageChain(ctx, branchId);
  const leaf = chain[chain.length - 1] as Branch;
  if (leaf.traceId !== traceId) throw ApiError.notFound("branch", branchId);
  let after: number;
  try {
    after = decodeCursor(query.cursor);
  } catch {
    throw ApiError.badRequest("invalid cursor");
  }
  const conditions: SQL[] = [
    query.inherited ? lineageCondition(chain) : eq(events.branchId, branchId),
  ];
  if (after >= 0) conditions.push(gt(events.sequence, after));
  if (query.eventType) conditions.push(eq(events.eventType, query.eventType));
  if (query.name) conditions.push(eq(events.name, query.name));
  if (query.severity) conditions.push(eq(events.severity, query.severity));
  if (query.q && query.q.trim()) {
    const pattern = `%${escapeLike(query.q.trim())}%`;
    conditions.push(or(ilike(events.name, pattern), ilike(events.eventType, pattern)) as SQL);
  }
  const rows = await ctx.handle.db
    .select()
    .from(events)
    .where(and(...conditions))
    .orderBy(asc(events.sequence))
    .limit(query.limit + 1);
  const items = rows.slice(0, query.limit).map(toEvent);
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: rows.length > query.limit && last ? encodeCursor(last.sequence) : null,
  };
}

export interface IngestResult {
  events: ShadowEvent[];
  branch: Branch;
}

/** Append events to a branch, assigning ids/sequences/timestamps when omitted. */
export async function ingestEvents(
  ctx: ServiceContext,
  traceId: string,
  body: IngestEventsBody,
): Promise<IngestResult> {
  const trace = await getTraceRow(ctx, traceId);
  const branchId = body.branchId ?? trace.rootBranchId;
  const branchRow = await getBranchRow(ctx, branchId);
  if (branchRow.traceId !== traceId)
    throw ApiError.badRequest(`branch ${branchId} does not belong to trace ${traceId}`);
  const inserted = await ctx.handle.db.transaction(async (tx) => {
    const [maxRow] = await tx
      .select({ max: sql<number | null>`max(${events.sequence})` })
      .from(events)
      .where(eq(events.branchId, branchId));
    let next = (maxRow?.max === null || maxRow?.max === undefined ? -1 : Number(maxRow.max)) + 1;
    const seen = new Set<number>();
    const prepared: ShadowEvent[] = [];
    for (const raw of body.events) {
      const sequence = raw.sequence ?? next;
      if (raw.sequence === undefined) next++;
      else if (raw.sequence >= next) next = raw.sequence + 1;
      if (seen.has(sequence))
        throw ApiError.conflict(`duplicate sequence ${sequence} in batch`, { sequence });
      seen.add(sequence);
      const parsed = eventSchema.safeParse({
        ...raw,
        id: raw.id ?? ctx.ids.next("evt"),
        traceId,
        branchId,
        sequence,
        timestamp: raw.timestamp ?? iso(new Date(ctx.clock.now())),
      });
      if (!parsed.success) throw ApiError.badRequest("invalid event", parsed.error.issues);
      const event = parsed.data;
      if (event.input !== undefined) event.input = ctx.redactor.redact(event.input);
      if (event.output !== undefined) event.output = ctx.redactor.redact(event.output);
      event.metadata = ctx.redactor.redact(event.metadata);
      prepared.push(event);
    }
    for (const part of chunk(prepared)) {
      try {
        await tx.insert(events).values(part.map(toEventRow));
      } catch (error) {
        const message = describeDbError(error);
        if (/duplicate key|unique/i.test(message)) {
          throw ApiError.conflict(
            "an event with the same id or sequence already exists on this branch",
            { cause: message },
          );
        }
        throw error;
      }
    }
    await insertSnapshots(tx, prepared);
    await applyLifecycle(tx, trace, branchRow, prepared);
    return prepared;
  });
  const branch = await writeBranchMetrics(
    ctx,
    branchId,
    mergeMetrics(toMetrics(branchRow.metrics), aggregateMetrics(inserted)),
  );
  await updateSearchText(ctx, trace, inserted);
  return { events: inserted, branch };
}

/** Drizzle wraps driver failures in `DrizzleQueryError`; the Postgres message lives on `cause`. */
function describeDbError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? error.cause.message : "";
  return cause ? `${error.message}: ${cause}` : error.message;
}

type Tx = Parameters<Parameters<ServiceContext["handle"]["db"]["transaction"]>[0]>[0];

export async function insertSnapshots(
  tx: Tx | ServiceContext["handle"]["db"],
  list: readonly ShadowEvent[],
) {
  const rows = [];
  for (const event of list) {
    if (event.eventType !== "state.snapshot") continue;
    const payload = stateSnapshotPayloadSchema.safeParse(event.output);
    if (!payload.success) continue;
    rows.push({
      id: `snp_${event.id}`,
      traceId: event.traceId,
      branchId: event.branchId,
      eventId: event.id,
      sequence: event.sequence,
      stateVersion: event.stateVersion ?? null,
      state: payload.data.state,
      context: payload.data.context,
      createdAt: event.timestamp,
    });
  }
  for (const part of chunk(rows))
    await tx.insert(stateSnapshots).values(part).onConflictDoNothing();
}

async function applyLifecycle(
  tx: Tx,
  trace: TraceRow,
  branch: BranchRow,
  list: readonly ShadowEvent[],
) {
  const end = [...list]
    .reverse()
    .find((e) => e.eventType === "trace.completed" || e.eventType === "trace.failed");
  const started = list.find((e) => e.eventType === "trace.started");
  const now = iso(new Date());
  if (started && branch.id === trace.rootBranchId) {
    await tx
      .update(traces)
      .set({ startedAt: started.timestamp, updatedAt: now })
      .where(eq(traces.id, trace.id));
  }
  if (!end) return;
  const outcome = deriveOutcome(list);
  const status = end.eventType === "trace.failed" ? "failed" : "completed";
  await tx
    .update(branches)
    .set({ status, outcome, updatedAt: now })
    .where(eq(branches.id, branch.id));
  if (branch.id === trace.rootBranchId) {
    const startedAt = started?.timestamp ?? iso(trace.startedAt);
    await tx
      .update(traces)
      .set({
        status,
        outcome,
        completedAt: end.timestamp,
        durationMs: Math.max(0, Date.parse(end.timestamp) - Date.parse(startedAt)),
        updatedAt: now,
      })
      .where(eq(traces.id, trace.id));
  }
}

/**
 * Persist a branch's metrics and keep the trace-level aggregates in sync.
 * Ingestion and replay merge incrementally (see `mergeMetrics`); import and
 * repairs use `recomputeBranchMetrics`, which derives the same numbers from
 * the full effective timeline.
 */
export async function writeBranchMetrics(
  ctx: ServiceContext,
  branchId: string,
  metrics: BranchMetrics,
): Promise<Branch> {
  const row = await getBranchRow(ctx, branchId);
  const now = iso(new Date(ctx.clock.now()));
  await ctx.handle.db
    .update(branches)
    .set({ metrics, updatedAt: now })
    .where(eq(branches.id, branchId));
  const trace = await getTraceRow(ctx, row.traceId);
  const [count] = await ctx.handle.db
    .select({ count: sql<number>`count(*)` })
    .from(branches)
    .where(eq(branches.traceId, row.traceId));
  const patch: Partial<typeof traces.$inferInsert> = {
    branchCount: Number(count?.count ?? 1),
    updatedAt: now,
  };
  if (trace.rootBranchId === branchId) {
    patch.metrics = metrics;
    patch.durationMs = trace.durationMs ?? metrics.durationMs;
  }
  await ctx.handle.db.update(traces).set(patch).where(eq(traces.id, trace.id));
  return toBranch(await getBranchRow(ctx, branchId));
}

/** Recompute usage/cost aggregates for a branch from its full effective timeline. */
export async function recomputeBranchMetrics(
  ctx: ServiceContext,
  branchId: string,
): Promise<Branch> {
  const { all, chain } = await lineageChain(ctx, branchId);
  const branch = chain[chain.length - 1] as Branch;
  const own = new Map<string, ShadowEvent[]>();
  for (const b of chain) own.set(b.id, await loadOwnEvents(ctx, b.id));
  const timeline = effectiveEvents(all, branchId, (id) => own.get(id) ?? []);
  const outcome = branch.outcome ?? deriveOutcome(timeline);
  await ctx.handle.db.update(branches).set({ outcome }).where(eq(branches.id, branchId));
  return writeBranchMetrics(ctx, branchId, aggregateMetrics(timeline));
}

export async function updateSearchText(
  ctx: ServiceContext,
  trace: TraceRow,
  list: readonly ShadowEvent[],
) {
  const [project] = await ctx.handle.db
    .select()
    .from(projects)
    .where(eq(projects.id, trace.projectId))
    .limit(1);
  const [agent] = await ctx.handle.db
    .select()
    .from(agents)
    .where(eq(agents.id, trace.agentId))
    .limit(1);
  if (!project || !agent) return;
  const searchText = likeSearchProvider.buildSearchText({
    trace: {
      id: trace.id,
      name: trace.name,
      tags: (trace.tags as string[]) ?? [],
      metadata: (trace.metadata as ShadowEvent["metadata"]) ?? {},
    },
    agent,
    project,
    events: list,
    previous: trace.searchText,
  });
  await ctx.handle.db.update(traces).set({ searchText }).where(eq(traces.id, trace.id));
}

/** Largest value of the `integer` sequence columns. */
const MAX_SEQUENCE = 2_147_483_647;

/** Reconstruct state at an event boundary using the nearest stored snapshot. */
export async function getBranchState(
  ctx: ServiceContext,
  branchId: string,
  target: { sequence?: number; eventId?: string },
): Promise<ReconstructedState & { branchId: string }> {
  const { chain } = await lineageChain(ctx, branchId);
  // `sequence` is an int4 column; a larger bound is rejected by Postgres.
  let upTo = Math.min(target.sequence ?? MAX_SEQUENCE, MAX_SEQUENCE);
  if (target.eventId) {
    const [row] = await ctx.handle.db
      .select({ sequence: events.sequence })
      .from(events)
      .where(and(lineageCondition(chain), eq(events.id, target.eventId)))
      .limit(1);
    if (!row) throw ApiError.notFound("event", target.eventId);
    upTo = row.sequence;
  }
  const [snapshot] = await ctx.handle.db
    .select()
    .from(stateSnapshots)
    .where(and(snapshotLineageCondition(chain), lte(stateSnapshots.sequence, upTo)))
    .orderBy(desc(stateSnapshots.sequence))
    .limit(1);
  const after = snapshot ? snapshot.sequence : -1;
  const rows = await ctx.handle.db
    .select()
    .from(events)
    .where(
      and(
        lineageCondition(chain),
        gt(events.sequence, after),
        lte(events.sequence, upTo),
        inArray(events.eventType, [...STATE_MUTATING_EVENT_TYPES]),
      ),
    )
    .orderBy(asc(events.sequence));
  const timeline: ShadowEvent[] = rows.map(toEvent);
  if (snapshot) {
    timeline.unshift({
      id: snapshot.eventId,
      schemaVersion: "1.0",
      traceId: snapshot.traceId,
      branchId: snapshot.branchId,
      parentEventId: null,
      spanId: null,
      parentSpanId: null,
      sequence: snapshot.sequence,
      timestamp: iso(snapshot.createdAt),
      durationMs: null,
      eventType: "state.snapshot",
      source: "api",
      severity: "info",
      name: "snapshot",
      output: {
        state: snapshot.state as ShadowEvent["metadata"],
        context: snapshot.context as ShadowEvent["metadata"],
      },
      metadata: {},
      tags: [],
      tokenUsage: null,
      estimatedCost: null,
      stateVersion: snapshot.stateVersion,
      correlationId: null,
    });
  }
  const result = reconstructState(sortEvents(timeline), { upToSequence: upTo });
  return { ...result, branchId };
}

/** Events referenced by a list of rows (used by export). */
export function rowsToEvents(rows: EventRow[]): ShadowEvent[] {
  return rows.map(toEvent);
}
