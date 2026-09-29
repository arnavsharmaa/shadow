import { and, desc, eq, gte, inArray, lt, lte, sql, type SQL } from "drizzle-orm";
import { agents, projects, traces } from "../db/schema.js";
import { ApiError } from "../errors.js";
import type { ServiceContext } from "./context.js";
import { isoOrNull } from "./mappers.js";

export interface AgentStatsQuery {
  from?: string;
  to?: string;
  project?: string;
}

export interface AgentStats {
  agentId: string;
  agentSlug: string;
  agentName: string;
  projectSlug: string;
  projectName: string;
  traces: number;
  completed: number;
  failed: number;
  running: number;
  policyViolations: number;
  toolErrors: number;
  avgDurationMs: number | null;
  p95DurationMs: number | null;
  totalEstimatedCost: number;
  avgEstimatedCost: number | null;
  totalTokens: number;
  lastStartedAt: string | null;
}

const num = (value: unknown): number => Number(value ?? 0) || 0;
const nullableNum = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

/**
 * Per-agent aggregates over traces started in a time range: volume, failure and
 * policy-violation counts, latency (mean and p95), estimated cost and tokens.
 * Computed in SQL from the trace rows' stored metrics, so it stays cheap as the
 * event table grows.
 */
export async function agentStats(
  ctx: ServiceContext,
  query: AgentStatsQuery,
): Promise<AgentStats[]> {
  const filters: SQL[] = [];
  if (query.from) filters.push(gte(traces.startedAt, query.from));
  if (query.to) filters.push(lte(traces.startedAt, query.to));
  if (query.project) filters.push(eq(projects.slug, query.project));
  const cost = sql<number>`coalesce((${traces.metrics}->>'totalEstimatedCost')::float, 0)`;
  const durationMs = sql<number>`coalesce(${traces.durationMs}, (${traces.metrics}->>'durationMs')::float, 0)`;
  const base = ctx.handle.db
    .select({
      agentId: agents.id,
      agentSlug: agents.slug,
      agentName: agents.name,
      projectSlug: projects.slug,
      projectName: projects.name,
      traces: sql<number>`count(*)`,
      completed: sql<number>`count(*) filter (where ${traces.status} = 'completed')`,
      failed: sql<number>`count(*) filter (where ${traces.status} = 'failed')`,
      running: sql<number>`count(*) filter (where ${traces.status} = 'running')`,
      policyViolations: sql<number>`count(*) filter (where ${traces.outcome}->>'kind' = 'policy_violation')`,
      toolErrors: sql<number>`coalesce(sum((${traces.metrics}->>'toolErrors')::float), 0)`,
      avgDurationMs: sql<number | null>`avg(${durationMs})`,
      p95DurationMs: sql<
        number | null
      >`percentile_cont(0.95) within group (order by ${durationMs})`,
      totalEstimatedCost: sql<number>`coalesce(sum(${cost}), 0)`,
      avgEstimatedCost: sql<number | null>`avg(${cost})`,
      totalTokens: sql<number>`coalesce(sum((${traces.metrics}->>'totalTokens')::float), 0)`,
      lastStartedAt: sql<string | null>`max(${traces.startedAt})`,
    })
    .from(traces)
    .innerJoin(agents, eq(agents.id, traces.agentId))
    .innerJoin(projects, eq(projects.id, traces.projectId));
  const rows = await (filters.length > 0 ? base.where(and(...filters)) : base)
    .groupBy(agents.id, agents.slug, agents.name, projects.slug, projects.name)
    .orderBy(desc(sql`count(*)`), agents.slug);
  return rows.map((row) => ({
    agentId: row.agentId,
    agentSlug: row.agentSlug,
    agentName: row.agentName,
    projectSlug: row.projectSlug,
    projectName: row.projectName,
    traces: num(row.traces),
    completed: num(row.completed),
    failed: num(row.failed),
    running: num(row.running),
    policyViolations: num(row.policyViolations),
    toolErrors: num(row.toolErrors),
    avgDurationMs: nullableNum(row.avgDurationMs),
    p95DurationMs: nullableNum(row.p95DurationMs),
    totalEstimatedCost: num(row.totalEstimatedCost),
    avgEstimatedCost: nullableNum(row.avgEstimatedCost),
    totalTokens: num(row.totalTokens),
    lastStartedAt: isoOrNull(row.lastStartedAt),
  }));
}

export type TrendBucket = "hour" | "day";

export interface AgentTrendQuery {
  bucket: TrendBucket;
  from?: string;
  to?: string;
  project?: string;
}

export interface AgentTrendPoint {
  /** Start of the bucket (UTC). */
  start: string;
  traces: number;
  completed: number;
  failed: number;
  policyViolations: number;
  avgDurationMs: number | null;
  p95DurationMs: number | null;
  totalEstimatedCost: number;
  totalTokens: number;
}

export interface AgentTrend {
  agent: string;
  project: string | null;
  bucket: TrendBucket;
  from: string;
  to: string;
  points: AgentTrendPoint[];
}

const BUCKET_MS: Record<TrendBucket, number> = { hour: 3_600_000, day: 86_400_000 };
const DEFAULT_SPAN: Record<TrendBucket, number> = { hour: 48, day: 30 };
export const MAX_TREND_POINTS = 1000;

function truncateUtc(ms: number, bucket: TrendBucket): number {
  return Math.floor(ms / BUCKET_MS[bucket]) * BUCKET_MS[bucket];
}

/**
 * One agent's traces grouped into hourly or daily UTC buckets, with every bucket in the range
 * present (empty ones as zeros) so charts need no gap handling. Defaults to the last 30 days
 * (daily) or 48 hours (hourly); at most 1000 buckets.
 */
export async function agentTrend(
  ctx: ServiceContext,
  agentSlug: string,
  query: AgentTrendQuery,
): Promise<AgentTrend> {
  const agentFilters: SQL[] = [eq(agents.slug, agentSlug)];
  if (query.project) agentFilters.push(eq(projects.slug, query.project));
  const matching = await ctx.handle.db
    .select({ id: agents.id })
    .from(agents)
    .innerJoin(projects, eq(projects.id, agents.projectId))
    .where(and(...agentFilters));
  if (matching.length === 0) throw ApiError.notFound("agent", agentSlug);

  const step = BUCKET_MS[query.bucket];
  const toMs = query.to ? Date.parse(query.to) : ctx.clock.now();
  const fromMs = query.from ? Date.parse(query.from) : toMs - DEFAULT_SPAN[query.bucket] * step;
  if (fromMs > toMs) throw ApiError.badRequest("from must not be after to");
  const first = truncateUtc(fromMs, query.bucket);
  const last = truncateUtc(toMs, query.bucket);
  const count = (last - first) / step + 1;
  if (count > MAX_TREND_POINTS) {
    throw ApiError.badRequest(
      `the range covers ${count} ${query.bucket}s; at most ${MAX_TREND_POINTS} buckets are returned`,
    );
  }

  const unit = sql.raw(`'${query.bucket}'`);
  const bucketStart = sql<string>`date_trunc(${unit}, ${traces.startedAt} at time zone 'UTC') at time zone 'UTC'`;
  const cost = sql<number>`coalesce((${traces.metrics}->>'totalEstimatedCost')::float, 0)`;
  const durationMs = sql<number>`coalesce(${traces.durationMs}, (${traces.metrics}->>'durationMs')::float, 0)`;
  const rows = await ctx.handle.db
    .select({
      start: bucketStart,
      traces: sql<number>`count(*)`,
      completed: sql<number>`count(*) filter (where ${traces.status} = 'completed')`,
      failed: sql<number>`count(*) filter (where ${traces.status} = 'failed')`,
      policyViolations: sql<number>`count(*) filter (where ${traces.outcome}->>'kind' = 'policy_violation')`,
      avgDurationMs: sql<number | null>`avg(${durationMs})`,
      p95DurationMs: sql<
        number | null
      >`percentile_cont(0.95) within group (order by ${durationMs})`,
      totalEstimatedCost: sql<number>`coalesce(sum(${cost}), 0)`,
      totalTokens: sql<number>`coalesce(sum((${traces.metrics}->>'totalTokens')::float), 0)`,
    })
    .from(traces)
    .where(
      and(
        inArray(
          traces.agentId,
          matching.map((m) => m.id),
        ),
        gte(traces.startedAt, new Date(first).toISOString()),
        lt(traces.startedAt, new Date(last + step).toISOString()),
      ),
    )
    .groupBy(bucketStart);

  const byStart = new Map(rows.map((row) => [Date.parse(isoOrNull(row.start) ?? ""), row]));
  const points: AgentTrendPoint[] = [];
  for (let at = first; at <= last; at += step) {
    const row = byStart.get(at);
    points.push({
      start: new Date(at).toISOString(),
      traces: num(row?.traces),
      completed: num(row?.completed),
      failed: num(row?.failed),
      policyViolations: num(row?.policyViolations),
      avgDurationMs: row ? nullableNum(row.avgDurationMs) : null,
      p95DurationMs: row ? nullableNum(row.p95DurationMs) : null,
      totalEstimatedCost: num(row?.totalEstimatedCost),
      totalTokens: num(row?.totalTokens),
    });
  }
  return {
    agent: agentSlug,
    project: query.project ?? null,
    bucket: query.bucket,
    from: new Date(first).toISOString(),
    to: new Date(last + step).toISOString(),
    points,
  };
}
