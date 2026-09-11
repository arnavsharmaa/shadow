import {
  SCHEMA_VERSION,
  type CreateTraceBody,
  type PruneTracesBody,
  type Trace,
  type TraceListQuery,
  type TraceSummary,
  type UpdateTraceBody,
} from "@shadow/schemas";
import { and, asc, desc, eq, gte, inArray, lt, lte, sql, type SQL } from "drizzle-orm";
import { agents, branches, projects, traces } from "../db/schema.js";
import { ApiError } from "../errors.js";
import type { ServiceContext } from "./context.js";
import {
  iso,
  toTrace,
  toTraceSummary,
  type AgentRow,
  type ProjectRow,
  type TraceRow,
} from "./mappers.js";
import { ensureAgent, ensureProject } from "./projects.js";
import { likeSearchProvider } from "./search.js";

export async function getTraceRow(ctx: ServiceContext, traceId: string): Promise<TraceRow> {
  const [row] = await ctx.handle.db.select().from(traces).where(eq(traces.id, traceId)).limit(1);
  if (!row) throw ApiError.notFound("trace", traceId);
  return row;
}

export async function getTraceSummary(ctx: ServiceContext, traceId: string): Promise<TraceSummary> {
  const rows = await ctx.handle.db
    .select({ trace: traces, project: projects, agent: agents })
    .from(traces)
    .innerJoin(projects, eq(projects.id, traces.projectId))
    .innerJoin(agents, eq(agents.id, traces.agentId))
    .where(eq(traces.id, traceId))
    .limit(1);
  const row = rows[0];
  if (!row) throw ApiError.notFound("trace", traceId);
  return toTraceSummary(row.trace, row.project, row.agent);
}

export async function createTrace(
  ctx: ServiceContext,
  body: CreateTraceBody,
  options: { rootBranchId?: string } = {},
): Promise<Trace> {
  const project = await ensureProject(ctx, { slug: body.project });
  const agent = await ensureAgent(ctx, { projectId: project.id, slug: body.agent });
  const id = body.id ?? ctx.ids.next("trc");
  const existing = await ctx.handle.db
    .select({ id: traces.id })
    .from(traces)
    .where(eq(traces.id, id))
    .limit(1);
  if (existing[0]) throw ApiError.conflict(`trace ${id} already exists`, { traceId: id });
  const now = iso(new Date(ctx.clock.now()));
  const startedAt = body.startedAt ?? now;
  const rootBranchId = options.rootBranchId ?? ctx.ids.next("br");
  const searchText = likeSearchProvider.buildSearchText({
    trace: { id, name: body.name, tags: body.tags ?? [], metadata: body.metadata ?? {} },
    agent,
    project,
    events: [],
  });
  const row = await ctx.handle.db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(traces)
      .values({
        id,
        projectId: project.id,
        agentId: agent.id,
        rootBranchId,
        name: body.name,
        status: "running",
        schemaVersion: SCHEMA_VERSION,
        startedAt,
        tags: body.tags ?? [],
        metadata: body.metadata ?? {},
        metrics: {},
        branchCount: 1,
        searchText,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await tx.insert(branches).values({
      id: rootBranchId,
      traceId: id,
      name: "main",
      depth: 0,
      status: "recording",
      metrics: {},
      createdAt: now,
      updatedAt: now,
    });
    return inserted as TraceRow;
  });
  return toTrace(row);
}

function sortColumn(sort: TraceListQuery["sort"]) {
  switch (sort) {
    case "durationMs":
      return sql`coalesce(${traces.durationMs}, 0)`;
    case "totalEstimatedCost":
      return sql`coalesce((${traces.metrics}->>'totalEstimatedCost')::float, 0)`;
    case "totalTokens":
      return sql`coalesce((${traces.metrics}->>'totalTokens')::float, 0)`;
    case "name":
      return traces.name;
    case "startedAt":
    default:
      return traces.startedAt;
  }
}

function decodeOffset(cursor: string | undefined): number {
  if (!cursor) return 0;
  const n = Number.parseInt(Buffer.from(cursor, "base64url").toString("utf8"), 10);
  if (!Number.isInteger(n) || n < 0) throw ApiError.badRequest("invalid cursor");
  return n;
}

export async function listTraces(
  ctx: ServiceContext,
  query: TraceListQuery,
): Promise<{ items: TraceSummary[]; nextCursor: string | null; total: number }> {
  const filters: SQL[] = [];
  if (query.project) filters.push(eq(projects.slug, query.project));
  if (query.agent) filters.push(eq(agents.slug, query.agent));
  if (query.status) filters.push(eq(traces.status, query.status));
  if (query.tag) filters.push(sql`${traces.tags} @> ${JSON.stringify([query.tag])}::jsonb`);
  if (query.tool) filters.push(likeSearchProvider.filter(`tool:${query.tool}`));
  if (query.q) filters.push(likeSearchProvider.filter(query.q));
  if (query.from) filters.push(gte(traces.startedAt, query.from));
  if (query.to) filters.push(lte(traces.startedAt, query.to));
  if (query.minCost !== undefined) {
    filters.push(
      sql`coalesce((${traces.metrics}->>'totalEstimatedCost')::float, 0) >= ${query.minCost}`,
    );
  }
  if (query.minDurationMs !== undefined)
    filters.push(sql`coalesce(${traces.durationMs}, 0) >= ${query.minDurationMs}`);
  const where = filters.length > 0 ? and(...filters) : undefined;
  const offset = decodeOffset(query.cursor);
  const orderBy =
    query.order === "asc" ? asc(sortColumn(query.sort)) : desc(sortColumn(query.sort));

  const base = ctx.handle.db
    .select({ trace: traces, project: projects, agent: agents })
    .from(traces)
    .innerJoin(projects, eq(projects.id, traces.projectId))
    .innerJoin(agents, eq(agents.id, traces.agentId));
  const rows = await (where ? base.where(where) : base)
    .orderBy(orderBy, desc(traces.id))
    .limit(query.limit + 1)
    .offset(offset);
  const countQuery = ctx.handle.db
    .select({ count: sql<number>`count(*)` })
    .from(traces)
    .innerJoin(projects, eq(projects.id, traces.projectId))
    .innerJoin(agents, eq(agents.id, traces.agentId));
  const [countRow] = await (where ? countQuery.where(where) : countQuery);
  const items = rows
    .slice(0, query.limit)
    .map((r) => toTraceSummary(r.trace as TraceRow, r.project as ProjectRow, r.agent as AgentRow));
  const nextCursor =
    rows.length > query.limit
      ? Buffer.from(String(offset + query.limit)).toString("base64url")
      : null;
  return { items, nextCursor, total: Number(countRow?.count ?? 0) };
}

/**
 * Edit a trace's name, tags and metadata. Tags are de-duplicated and keep their
 * order; metadata keys set to `null` are removed. The search text is rebuilt so
 * new names and tags become searchable immediately.
 */
export async function updateTrace(
  ctx: ServiceContext,
  traceId: string,
  body: UpdateTraceBody,
): Promise<Trace> {
  const row = await getTraceRow(ctx, traceId);
  const [project] = await ctx.handle.db
    .select()
    .from(projects)
    .where(eq(projects.id, row.projectId))
    .limit(1);
  const [agent] = await ctx.handle.db
    .select()
    .from(agents)
    .where(eq(agents.id, row.agentId))
    .limit(1);
  if (!project || !agent) throw ApiError.notFound("trace", traceId);

  const current = toTrace(row);
  const name = body.name ?? current.name;
  let tags = body.tags ?? current.tags;
  if (body.addTags) tags = [...tags, ...body.addTags];
  if (body.removeTags) {
    const removed = new Set(body.removeTags);
    tags = tags.filter((tag) => !removed.has(tag));
  }
  tags = [...new Set(tags)];
  const metadata = { ...current.metadata };
  for (const [key, value] of Object.entries(body.metadata ?? {})) {
    if (value === null) delete metadata[key];
    else metadata[key] = value;
  }
  const searchText = likeSearchProvider.buildSearchText({
    trace: { id: row.id, name, tags, metadata },
    agent,
    project,
    events: [],
    previous: row.searchText,
  });
  const [updated] = await ctx.handle.db
    .update(traces)
    .set({ name, tags, metadata, searchText, updatedAt: iso(new Date(ctx.clock.now())) })
    .where(eq(traces.id, traceId))
    .returning();
  return toTrace(updated as TraceRow);
}

export async function deleteTrace(ctx: ServiceContext, traceId: string): Promise<void> {
  await getTraceRow(ctx, traceId);
  await ctx.handle.db.delete(traces).where(eq(traces.id, traceId));
}

export interface PruneResult {
  dryRun: boolean;
  /** Traces matching the criteria (capped at `limit`). */
  matched: number;
  /** Ids removed (or, in a dry run, that would be removed). Oldest first. */
  traceIds: string[];
  /** Whether more traces matched than `limit` allowed in one call. */
  truncated: boolean;
}

/**
 * Delete traces that started before a cutoff, optionally narrowed by project,
 * agent, status or tag. Deletion cascades like `deleteTrace`. Oldest traces go
 * first so repeated calls with the same `limit` drain the backlog in order.
 */
export async function pruneTraces(
  ctx: ServiceContext,
  body: PruneTracesBody,
): Promise<PruneResult> {
  const filters: SQL[] = [lt(traces.startedAt, body.before)];
  if (body.project) filters.push(eq(projects.slug, body.project));
  if (body.agent) filters.push(eq(agents.slug, body.agent));
  if (body.status) filters.push(eq(traces.status, body.status));
  if (body.tag) filters.push(sql`${traces.tags} @> ${JSON.stringify([body.tag])}::jsonb`);
  const rows = await ctx.handle.db
    .select({ id: traces.id })
    .from(traces)
    .innerJoin(projects, eq(projects.id, traces.projectId))
    .innerJoin(agents, eq(agents.id, traces.agentId))
    .where(and(...filters))
    .orderBy(asc(traces.startedAt), asc(traces.id))
    .limit(body.limit + 1);
  const truncated = rows.length > body.limit;
  const traceIds = rows.slice(0, body.limit).map((r) => r.id);
  if (!body.dryRun && traceIds.length > 0) {
    await ctx.handle.db.delete(traces).where(inArray(traces.id, traceIds));
    ctx.logger.info({ count: traceIds.length, before: body.before }, "pruned traces");
  }
  return { dryRun: body.dryRun, matched: traceIds.length, traceIds, truncated };
}

/** Distinct filter values for the explorer UI. */
export async function traceFacets(ctx: ServiceContext) {
  const projectRows = await ctx.handle.db
    .select({ slug: projects.slug, name: projects.name })
    .from(projects)
    .orderBy(asc(projects.name));
  const agentRows = await ctx.handle.db
    .select({ slug: agents.slug, name: agents.name, projectSlug: projects.slug })
    .from(agents)
    .innerJoin(projects, eq(projects.id, agents.projectId))
    .orderBy(asc(agents.name));
  const tagRows = (await ctx.handle.db.execute(
    sql`select distinct value as tag from ${traces}, jsonb_array_elements_text(${traces.tags}) as value order by value`,
  )) as { rows: { tag: string }[] };
  const toolRows = (await ctx.handle.db.execute(
    sql`select distinct name as tool from events where event_type = 'tool.request' order by name`,
  )) as { rows: { tool: string }[] };
  return {
    projects: projectRows,
    agents: agentRows,
    tags: tagRows.rows.map((r) => r.tag),
    tools: toolRows.rows.map((r) => r.tool),
  };
}
