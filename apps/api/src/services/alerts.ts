import type {
  AlertMetric,
  AlertRule,
  CreateAlertRuleBody,
  UpdateAlertRuleBody,
} from "@shadow/schemas";
import { and, asc, eq, gte, lt, sql, type SQL } from "drizzle-orm";
import { agents, alertRules, events, projects, traces } from "../db/schema.js";
import { ApiError } from "../errors.js";
import { recordAudit } from "./audit.js";
import type { ServiceContext } from "./context.js";
import { iso } from "./mappers.js";

export const MAX_ALERT_RULES = 200;

type AlertRuleRow = typeof alertRules.$inferSelect;

function toAlertRule(row: AlertRuleRow): AlertRule {
  return {
    id: row.id,
    name: row.name,
    agent: row.agent,
    project: row.project,
    tag: row.tag,
    tool: row.tool,
    metric: row.metric as AlertMetric,
    mode: row.mode === "baseline" ? "baseline" : "threshold",
    baselineWindows: row.baselineWindows,
    lastBaseline: row.lastBaseline,
    threshold: row.threshold,
    windowMinutes: row.windowMinutes,
    minTraces: row.minTraces,
    keepFiringMinutes: row.keepFiringMinutes,
    enabled: row.enabled,
    state: row.state === "firing" ? "firing" : "ok",
    lastValue: row.lastValue,
    lastTraces: row.lastTraces,
    lastEvaluatedAt: row.lastEvaluatedAt ? iso(row.lastEvaluatedAt) : null,
    lastTriggeredAt: row.lastTriggeredAt ? iso(row.lastTriggeredAt) : null,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function now(ctx: ServiceContext): string {
  return iso(new Date(ctx.clock.now()));
}

export async function listAlertRules(ctx: ServiceContext): Promise<AlertRule[]> {
  const rows = await ctx.handle.db
    .select()
    .from(alertRules)
    .orderBy(asc(alertRules.name))
    .limit(MAX_ALERT_RULES);
  return rows.map(toAlertRule);
}

async function getRow(ctx: ServiceContext, ruleId: string): Promise<AlertRuleRow> {
  const [row] = await ctx.handle.db
    .select()
    .from(alertRules)
    .where(eq(alertRules.id, ruleId))
    .limit(1);
  if (!row) throw ApiError.notFound("alert rule", ruleId);
  return row;
}

export async function getAlertRule(ctx: ServiceContext, ruleId: string): Promise<AlertRule> {
  return toAlertRule(await getRow(ctx, ruleId));
}

/** The checks a rule body must pass whether it is stored or only previewed. */
function assertRuleShape(body: CreateAlertRuleBody): void {
  if (body.mode === "threshold" && body.metric === "failure_rate" && body.threshold > 1) {
    throw ApiError.badRequest("failure_rate is a fraction; the threshold must be between 0 and 1");
  }
  if (body.mode === "baseline" && body.threshold <= 1) {
    throw ApiError.badRequest(
      "in baseline mode the threshold is a multiplier of the baseline and must be above 1",
    );
  }
  if (body.mode === "baseline" && body.windowMinutes * (body.baselineWindows + 1) > 129_600) {
    throw ApiError.badRequest("the window plus its baseline may span at most 90 days");
  }
}

export interface AlertPreview {
  /** The metric over the rule's window right now, `null` without usable data. */
  value: number | null;
  baseline: number | null;
  traces: number;
  /** What the value is compared against: the threshold, or the baseline times it. */
  limit: number | null;
  /** Whether the rule would be firing after the next evaluation if it existed. */
  wouldFire: boolean;
}

/**
 * Measure a rule body against the recorded traces without storing it, so a rule can be tuned
 * before it exists: what the value is now, over how many traces, and whether it would fire.
 */
export async function previewAlertRule(
  ctx: ServiceContext,
  body: CreateAlertRuleBody,
): Promise<AlertPreview> {
  assertRuleShape(body);
  const scope = {
    agent: body.agent ?? null,
    project: body.project ?? null,
    tag: body.tag ?? null,
    tool: body.tool ?? null,
    metric: body.metric,
    windowMinutes: body.windowMinutes,
    baselineWindows: body.baselineWindows,
  };
  const { value, traces: count } = await measure(ctx, scope);
  const baseline = body.mode === "baseline" ? await baselineFor(ctx, scope) : null;
  const limit =
    body.mode === "baseline"
      ? baseline !== null && baseline > 0
        ? baseline * body.threshold
        : null
      : body.threshold;
  const wouldFire = value !== null && limit !== null && count >= body.minTraces && value >= limit;
  return { value, baseline, traces: count, limit, wouldFire };
}

export async function createAlertRule(
  ctx: ServiceContext,
  body: CreateAlertRuleBody,
): Promise<AlertRule> {
  assertRuleShape(body);
  const existing = await ctx.handle.db
    .select({ id: alertRules.id, name: alertRules.name })
    .from(alertRules)
    .limit(MAX_ALERT_RULES + 1);
  if (existing.some((r) => r.name === body.name)) {
    throw ApiError.conflict(`an alert rule named '${body.name}' already exists`);
  }
  if (existing.length >= MAX_ALERT_RULES) {
    throw ApiError.badRequest(`at most ${MAX_ALERT_RULES} alert rules can be stored`);
  }
  const at = now(ctx);
  const row: AlertRuleRow = {
    id: ctx.ids.next("alr"),
    name: body.name,
    agent: body.agent ?? null,
    project: body.project ?? null,
    tag: body.tag ?? null,
    tool: body.tool ?? null,
    metric: body.metric,
    mode: body.mode,
    baselineWindows: body.baselineWindows,
    lastBaseline: null,
    threshold: body.threshold,
    windowMinutes: body.windowMinutes,
    minTraces: body.minTraces,
    keepFiringMinutes: body.keepFiringMinutes,
    enabled: body.enabled,
    state: "ok",
    lastValue: null,
    lastTraces: null,
    lastEvaluatedAt: null,
    lastTriggeredAt: null,
    createdAt: at,
    updatedAt: at,
  };
  await ctx.handle.db.insert(alertRules).values(row);
  return toAlertRule(row);
}

export async function updateAlertRule(
  ctx: ServiceContext,
  ruleId: string,
  body: UpdateAlertRuleBody,
): Promise<AlertRule> {
  const current = await getRow(ctx, ruleId);
  const threshold = body.threshold ?? current.threshold;
  if (current.mode !== "baseline" && current.metric === "failure_rate" && threshold > 1) {
    throw ApiError.badRequest("failure_rate is a fraction; the threshold must be between 0 and 1");
  }
  if (current.mode === "baseline") {
    if (threshold <= 1) {
      throw ApiError.badRequest(
        "in baseline mode the threshold is a multiplier of the baseline and must be above 1",
      );
    }
    const windows = body.baselineWindows ?? current.baselineWindows;
    const minutes = body.windowMinutes ?? current.windowMinutes;
    if (minutes * (windows + 1) > 129_600) {
      throw ApiError.badRequest("the window plus its baseline may span at most 90 days");
    }
  }
  if (body.name !== undefined && body.name !== current.name) {
    const [clash] = await ctx.handle.db
      .select({ id: alertRules.id })
      .from(alertRules)
      .where(eq(alertRules.name, body.name))
      .limit(1);
    if (clash) throw ApiError.conflict(`an alert rule named '${body.name}' already exists`);
  }
  const [row] = await ctx.handle.db
    .update(alertRules)
    .set({
      ...body,
      // A disabled rule is never firing; it starts from ok when re-enabled.
      ...(body.enabled === false ? { state: "ok" } : {}),
      updatedAt: now(ctx),
    })
    .where(eq(alertRules.id, ruleId))
    .returning();
  if (!row) throw ApiError.notFound("alert rule", ruleId);
  return toAlertRule(row);
}

export async function deleteAlertRule(ctx: ServiceContext, ruleId: string): Promise<AlertRule> {
  const [row] = await ctx.handle.db.delete(alertRules).where(eq(alertRules.id, ruleId)).returning();
  if (!row) throw ApiError.notFound("alert rule", ruleId);
  return toAlertRule(row);
}

/** Metrics that add up over time; their baseline is averaged per window. */
const ADDITIVE: ReadonlySet<AlertMetric> = new Set([
  "policy_violations",
  "tool_errors",
  "total_cost",
]);

/**
 * The rule's metric over traces started in `[from, to)`, and how many traces that covers.
 * Defaults to the rule's current window, ending now.
 */
export async function measure(
  ctx: ServiceContext,
  rule: Pick<AlertRule, "agent" | "project" | "tag" | "tool" | "metric" | "windowMinutes">,
  range: { from: number; to: number } = {
    from: ctx.clock.now() - rule.windowMinutes * 60_000,
    to: ctx.clock.now() + 1,
  },
): Promise<{ value: number | null; traces: number }> {
  const filters: SQL[] = [
    gte(traces.startedAt, new Date(range.from).toISOString()),
    lt(traces.startedAt, new Date(range.to).toISOString()),
  ];
  if (rule.agent) filters.push(eq(agents.slug, rule.agent));
  if (rule.project) filters.push(eq(projects.slug, rule.project));
  if (rule.tag) filters.push(sql`${traces.tags} @> ${JSON.stringify([rule.tag])}::jsonb`);
  if (rule.tool) {
    // Traces that called the tool on any branch.
    filters.push(
      sql`exists (select 1 from ${events} e where e.trace_id = ${traces.id} and e.event_type = 'tool.request' and e.name = ${rule.tool})`,
    );
  }
  // Scoped to a tool, the rule counts that tool's errors instead of the trace's total.
  const toolErrors = rule.tool
    ? sql<number>`coalesce(sum((select count(*) from ${events} e where e.trace_id = ${traces.id} and e.event_type = 'tool.error' and e.name = ${rule.tool})), 0)`
    : sql<number>`coalesce(sum((${traces.metrics}->>'toolErrors')::float), 0)`;
  const durationMs = sql<number>`coalesce(${traces.durationMs}, (${traces.metrics}->>'durationMs')::float, 0)`;
  const [row] = await ctx.handle.db
    .select({
      traces: sql<number>`count(*)`,
      finished: sql<number>`count(*) filter (where ${traces.status} <> 'running')`,
      failed: sql<number>`count(*) filter (where ${traces.status} = 'failed')`,
      policyViolations: sql<number>`count(*) filter (where ${traces.outcome}->>'kind' = 'policy_violation')`,
      toolErrors,
      totalCost: sql<number>`coalesce(sum((${traces.metrics}->>'totalEstimatedCost')::float), 0)`,
      p95: sql<
        number | null
      >`percentile_cont(0.95) within group (order by ${durationMs}) filter (where ${traces.status} <> 'running')`,
    })
    .from(traces)
    .innerJoin(agents, eq(agents.id, traces.agentId))
    .innerJoin(projects, eq(projects.id, traces.projectId))
    .where(and(...filters));
  const count = Number(row?.traces ?? 0);
  const finished = Number(row?.finished ?? 0);
  switch (rule.metric) {
    case "failure_rate":
      return { value: finished > 0 ? Number(row?.failed ?? 0) / finished : null, traces: count };
    case "policy_violations":
      return { value: Number(row?.policyViolations ?? 0), traces: count };
    case "tool_errors":
      return { value: Number(row?.toolErrors ?? 0), traces: count };
    case "total_cost":
      return { value: Number(row?.totalCost ?? 0), traces: count };
    case "p95_duration_ms":
      return {
        value: row?.p95 === null || row?.p95 === undefined ? null : Number(row.p95),
        traces: count,
      };
  }
}

export interface AlertEvaluation {
  rule: AlertRule;
  /** `fired` and `resolved` are the state changes that send a notification. */
  transition: "fired" | "resolved" | "none";
  /** True when the value is back under the limit but `keepFiringMinutes` keeps the rule firing. */
  held: boolean;
}

/**
 * The value a baseline rule compares against: the metric over the `baselineWindows` windows
 * before the current one. Sums are averaged per window; rates and percentiles are taken over
 * the whole baseline period. `null` when the period has no usable data.
 */
export async function baselineFor(
  ctx: ServiceContext,
  rule: Pick<
    AlertRule,
    "agent" | "project" | "tag" | "tool" | "metric" | "windowMinutes" | "baselineWindows"
  >,
): Promise<number | null> {
  const windowMs = rule.windowMinutes * 60_000;
  const to = ctx.clock.now() - windowMs;
  const { value, traces: count } = await measure(ctx, rule, {
    from: to - rule.baselineWindows * windowMs,
    to,
  });
  if (value === null || count === 0) return null;
  return ADDITIVE.has(rule.metric) ? value / rule.baselineWindows : value;
}

/**
 * Evaluate every enabled rule once. A threshold rule fires while its value is at or above the
 * threshold; a baseline rule fires while its value is at or above `threshold` times a baseline
 * that is above zero (with no history there is nothing to compare against, so it stays ok).
 * Either way the window must hold at least `minTraces` traces. Only the change of state (ok to
 * firing, or back) notifies the webhook and is written to the audit log (`alert.fired`,
 * `alert.resolved` by `system:alerts`), so a rule that stays firing does not repeat itself. A
 * rule with `keepFiringMinutes` does not resolve until that long after it fired, so a value that
 * dips under the limit and comes back raises one alert rather than a burst.
 */
export async function evaluateAlertRules(ctx: ServiceContext): Promise<AlertEvaluation[]> {
  const rows = await ctx.handle.db
    .select()
    .from(alertRules)
    .where(eq(alertRules.enabled, true))
    .orderBy(asc(alertRules.name));
  const out: AlertEvaluation[] = [];
  for (const row of rows) {
    const rule = toAlertRule(row);
    const { value, traces: count } = await measure(ctx, rule);
    const baseline = rule.mode === "baseline" ? await baselineFor(ctx, rule) : null;
    const limit =
      rule.mode === "baseline"
        ? baseline !== null && baseline > 0
          ? baseline * rule.threshold
          : null
        : rule.threshold;
    const over = value !== null && limit !== null && count >= rule.minTraces && value >= limit;
    const heldUntil =
      rule.state === "firing" && rule.lastTriggeredAt !== null && rule.keepFiringMinutes > 0
        ? Date.parse(rule.lastTriggeredAt) + rule.keepFiringMinutes * 60_000
        : null;
    const held = !over && heldUntil !== null && ctx.clock.now() < heldUntil;
    const firing = over || held;
    const transition =
      firing && rule.state === "ok"
        ? "fired"
        : !firing && rule.state === "firing"
          ? "resolved"
          : "none";
    const at = now(ctx);
    const [updated] = await ctx.handle.db
      .update(alertRules)
      .set({
        state: firing ? "firing" : "ok",
        lastValue: value,
        lastBaseline: baseline,
        lastTraces: count,
        lastEvaluatedAt: at,
        ...(transition === "fired" ? { lastTriggeredAt: at } : {}),
      })
      .where(eq(alertRules.id, row.id))
      .returning();
    const next = toAlertRule(updated ?? row);
    if (transition !== "none") {
      ctx.logger.info(
        { rule: next.name, metric: next.metric, value, threshold: next.threshold, traces: count },
        transition === "fired" ? "alert firing" : "alert resolved",
      );
      ctx.metrics.alertTransitions.inc({ transition });
      // The audit log keeps the history of what fired when, next to who changed the rules.
      await recordAudit(ctx, {
        actor: "system:alerts",
        action: transition === "fired" ? "alert.fired" : "alert.resolved",
        targetType: "alert",
        targetId: next.id,
        details: {
          name: next.name,
          metric: next.metric,
          mode: next.mode,
          threshold: next.threshold,
          windowMinutes: next.windowMinutes,
          value,
          baseline,
          traces: count,
          ...(next.agent ? { agent: next.agent } : {}),
          ...(next.project ? { project: next.project } : {}),
          ...(next.tag ? { tag: next.tag } : {}),
          ...(next.tool ? { tool: next.tool } : {}),
        },
      });
      // Delivery is off the evaluation path; the webhook retries and never throws.
      void ctx.webhook.alert({
        type: transition === "fired" ? "alert.firing" : "alert.resolved",
        rule: {
          id: next.id,
          name: next.name,
          agent: next.agent,
          project: next.project,
          tag: next.tag,
          tool: next.tool,
          metric: next.metric,
          mode: next.mode,
          threshold: next.threshold,
          windowMinutes: next.windowMinutes,
        },
        value,
        baseline,
        traces: count,
      });
    }
    out.push({ rule: next, transition, held });
  }
  return out;
}
