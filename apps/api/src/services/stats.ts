import { and, desc, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import { agents, projects, traces } from "../db/schema.js";
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
