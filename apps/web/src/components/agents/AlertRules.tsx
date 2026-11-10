"use client";

import { api, type AlertRuleInput } from "@/lib/api";
import { duration, money, relativeTime } from "@/lib/format";
import type { AlertMetric, AlertRule, AuditEntry } from "@shadow/schemas";
import { ALERT_METRICS } from "@shadow/schemas";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Badge, Button, Dialog, EmptyState, ErrorState, Skeleton } from "../ui/primitives";

const METRIC_LABEL: Record<AlertMetric, string> = {
  failure_rate: "failure rate",
  policy_violations: "policy violations",
  tool_errors: "tool errors",
  total_cost: "estimated cost",
  avg_cost: "cost per trace",
  p95_duration_ms: "p95 duration",
};

const METRIC_HELP: Record<AlertMetric, string> = {
  failure_rate: "a fraction between 0 and 1, e.g. 0.25 for 25%",
  policy_violations: "a count of violations in the window",
  tool_errors: "a count of tool errors in the window",
  total_cost: "US dollars over the window",
  avg_cost: "US dollars per finished trace in the window",
  p95_duration_ms: "milliseconds",
};

const WINDOWS: { minutes: number; label: string }[] = [
  { minutes: 15, label: "15 minutes" },
  { minutes: 60, label: "1 hour" },
  { minutes: 360, label: "6 hours" },
  { minutes: 1440, label: "1 day" },
  { minutes: 10080, label: "7 days" },
];

/** How long a fired rule keeps firing even if the value drops back (0 = until it recovers). */
const HOLDS: { minutes: number; label: string }[] = [
  { minutes: 0, label: "until it recovers" },
  { minutes: 15, label: "15 minutes" },
  { minutes: 30, label: "30 minutes" },
  { minutes: 60, label: "1 hour" },
  { minutes: 360, label: "6 hours" },
  { minutes: 1440, label: "1 day" },
];

function formatValue(metric: AlertMetric, value: number | null): string {
  if (value === null) return "–";
  if (metric === "failure_rate") return `${Math.round(value * 100)}%`;
  if (metric === "total_cost" || metric === "avg_cost") return money(value);
  if (metric === "p95_duration_ms") return duration(value);
  return String(value);
}

function windowLabel(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function isAlertMetric(value: unknown): value is AlertMetric {
  return typeof value === "string" && (ALERT_METRICS as readonly string[]).includes(value);
}

/** One `alert.fired` or `alert.resolved` audit entry, read back into typed columns. */
interface Transition {
  id: string;
  at: string;
  fired: boolean;
  name: string;
  metric: AlertMetric | null;
  baseline: boolean;
  value: number | null;
  threshold: number | null;
  baselineValue: number | null;
  traces: number | null;
  scope: string;
}

function toTransition(entry: AuditEntry): Transition {
  const d = entry.details;
  const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  const scope = [
    str(d.project),
    str(d.agent),
    str(d.tag) !== null ? `#${String(d.tag)}` : null,
    str(d.tool) !== null ? `calling ${String(d.tool)}` : null,
  ].filter((s): s is string => s !== null);
  return {
    id: entry.id,
    at: entry.at,
    fired: entry.action === "alert.fired",
    name: str(d.name) ?? entry.targetId,
    metric: isAlertMetric(d.metric) ? d.metric : null,
    baseline: d.mode === "baseline",
    value: num(d.value),
    threshold: num(d.threshold),
    baselineValue: num(d.baseline),
    traces: num(d.traces),
    scope: scope.join(" ") || "every agent",
  };
}

/** `failure rate 100% (threshold 50%)` or `… (2× the baseline of 10%)`. */
function describeTransition(t: Transition): string {
  const metric = t.metric;
  const value = metric ? formatValue(metric, t.value) : String(t.value ?? "–");
  const label = metric ? METRIC_LABEL[metric] : "value";
  if (t.baseline) {
    const base = metric ? formatValue(metric, t.baselineValue) : String(t.baselineValue ?? "–");
    return `${label} ${value} (${t.threshold ?? "?"}× the baseline of ${base})`;
  }
  const limit = metric ? formatValue(metric, t.threshold) : String(t.threshold ?? "–");
  return `${label} ${value} (threshold ${limit})`;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** Agent slugs offered as suggestions for the scope. */
  agents: string[];
}

/** Create, pause and delete alert rules; the API evaluates them on its timer. */
export function AlertRulesDialog({ open, onClose, agents }: Props) {
  const queryClient = useQueryClient();
  const rules = useQuery({ queryKey: ["alert-rules"], queryFn: api.alertRules, enabled: open });
  // When rules fired and resolved: the API writes each transition to the audit log.
  const history = useQuery({
    queryKey: ["alert-history"],
    queryFn: () => api.auditLog({ actor: "system:alerts", limit: 40 }),
    enabled: open,
  });
  const transitions = (history.data?.items ?? [])
    .filter((e) => e.action === "alert.fired" || e.action === "alert.resolved")
    .slice(0, 20)
    .map(toTransition);
  const [name, setName] = useState("");
  const [metric, setMetric] = useState<AlertMetric>("failure_rate");
  const [agent, setAgent] = useState("");
  const [tag, setTag] = useState("");
  const [tool, setTool] = useState("");
  const [mode, setMode] = useState<"threshold" | "baseline">("threshold");
  const [threshold, setThreshold] = useState("0.25");
  const [windowMinutes, setWindowMinutes] = useState(60);
  const [minTraces, setMinTraces] = useState("1");
  const [keepFiringMinutes, setKeepFiringMinutes] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["alert-rules"] });
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  const create = useMutation({
    mutationFn: (body: AlertRuleInput) => api.createAlertRule(body),
    onSuccess: async () => {
      setName("");
      setError(null);
      setPreview(null);
      await refresh();
    },
    onError: fail,
  });
  const previewRule = useMutation({
    mutationFn: (body: AlertRuleInput) => api.previewAlertRule(body),
    onSuccess: (result) => {
      setError(null);
      const value = result.value === null ? "no data" : formatValue(metric, result.value);
      const limit = result.limit === null ? "no baseline yet" : formatValue(metric, result.limit);
      setPreview(
        `Now: ${METRIC_LABEL[metric]} ${value} over ${result.traces} trace${result.traces === 1 ? "" : "s"}, limit ${limit}${result.baseline !== null ? ` (baseline ${formatValue(metric, result.baseline)})` : ""}: would ${result.wouldFire ? "fire" : "stay ok"}.`,
      );
    },
    onError: fail,
  });
  const toggle = useMutation({
    mutationFn: (rule: AlertRule) => api.updateAlertRule(rule.id, { enabled: !rule.enabled }),
    onSuccess: refresh,
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (rule: AlertRule) => api.deleteAlertRule(rule.id),
    onSuccess: refresh,
    onError: fail,
  });

  const thresholdValue = Number(threshold);
  const canCreate =
    name.trim() !== "" &&
    Number.isFinite(thresholdValue) &&
    thresholdValue >= 0 &&
    !create.isPending;
  const ruleBody = (): AlertRuleInput => ({
    name: name.trim() || "preview",
    metric,
    threshold: thresholdValue,
    mode,
    windowMinutes,
    minTraces: Math.max(1, Number(minTraces) || 1),
    keepFiringMinutes,
    ...(agent.trim() ? { agent: agent.trim() } : {}),
    ...(tag.trim() ? { tag: tag.trim() } : {}),
    ...(tool.trim() ? { tool: tool.trim() } : {}),
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Alert rules"
      width="max-w-4xl"
      testId="alert-rules"
    >
      <form
        className="flex flex-wrap items-end gap-2 border-b border-border px-4 py-3 text-[12px]"
        onSubmit={(e) => {
          e.preventDefault();
          if (!canCreate) return;
          create.mutate(ruleBody());
        }}
      >
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-fg-muted">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="refund failures"
            maxLength={128}
            className="h-7 w-44 rounded border border-border bg-bg px-2"
            data-testid="rule-name"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-fg-muted">Metric</span>
          <select
            value={metric}
            onChange={(e) => setMetric(e.target.value as AlertMetric)}
            className="h-7 rounded border border-border bg-bg px-1"
            data-testid="rule-metric"
          >
            {ALERT_METRICS.map((m) => (
              <option key={m} value={m}>
                {METRIC_LABEL[m]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-fg-muted">Agent (optional)</span>
          <input
            value={agent}
            onChange={(e) => setAgent(e.target.value)}
            list="rule-agents"
            placeholder="every agent"
            maxLength={64}
            className="h-7 w-36 rounded border border-border bg-bg px-2"
            data-testid="rule-agent"
          />
          <datalist id="rule-agents">
            {agents.map((slug) => (
              <option key={slug} value={slug} />
            ))}
          </datalist>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-fg-muted">Tag (optional)</span>
          <input
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            placeholder="any tag"
            maxLength={64}
            title="Only traces carrying this tag count, so one rule can watch prod and another staging"
            className="h-7 w-28 rounded border border-border bg-bg px-2"
            data-testid="rule-tag"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-fg-muted">Tool (optional)</span>
          <input
            value={tool}
            onChange={(e) => setTool(e.target.value)}
            placeholder="any tool"
            maxLength={128}
            title="Only traces that called this tool count; tool errors then counts this tool's errors only"
            className="h-7 w-32 rounded border border-border bg-bg px-2 font-mono text-[11px]"
            data-testid="rule-tool"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-fg-muted">Mode</span>
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as "threshold" | "baseline")}
            className="h-7 rounded border border-border bg-bg px-1"
            data-testid="rule-mode"
          >
            <option value="threshold">at or above a value</option>
            <option value="baseline">× its recent baseline</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-fg-muted">
            {mode === "baseline" ? "Multiplier" : "Threshold"}
          </span>
          <input
            type="number"
            min={0}
            step="any"
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
            className="h-7 w-24 rounded border border-border bg-bg px-2"
            data-testid="rule-threshold"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-fg-muted">Window</span>
          <select
            value={windowMinutes}
            onChange={(e) => setWindowMinutes(Number(e.target.value))}
            className="h-7 rounded border border-border bg-bg px-1"
            data-testid="rule-window"
          >
            {WINDOWS.map((w) => (
              <option key={w.minutes} value={w.minutes}>
                {w.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-fg-muted">Min traces</span>
          <input
            type="number"
            min={1}
            value={minTraces}
            onChange={(e) => setMinTraces(e.target.value)}
            className="h-7 w-20 rounded border border-border bg-bg px-2"
            data-testid="rule-min-traces"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-fg-muted">Keep firing</span>
          <select
            value={keepFiringMinutes}
            onChange={(e) => setKeepFiringMinutes(Number(e.target.value))}
            className="h-7 rounded border border-border bg-bg px-1"
            title="Once fired, the rule stays firing for at least this long, so a metric hovering around the limit raises one alert"
            data-testid="rule-keep-firing"
          >
            {HOLDS.map((h) => (
              <option key={h.minutes} value={h.minutes}>
                {h.label}
              </option>
            ))}
          </select>
        </label>
        <Button
          type="button"
          disabled={!Number.isFinite(thresholdValue) || thresholdValue < 0 || previewRule.isPending}
          onClick={() => previewRule.mutate(ruleBody())}
          title="Measure this rule against the recorded traces now, without creating it"
          data-testid="preview-rule"
        >
          Preview
        </Button>
        <Button type="submit" variant="primary" disabled={!canCreate} data-testid="create-rule">
          Add rule
        </Button>
        <span className="basis-full text-[11px] text-fg-faint">
          {mode === "baseline"
            ? "Fires while the metric is at or above the multiplier times its average over the preceding windows."
            : `Fires while the metric is at or above the threshold: ${METRIC_HELP[metric]}.`}
        </span>
        {preview && (
          <span className="basis-full text-[11px] text-fg" role="status" data-testid="rule-preview">
            {preview}
          </span>
        )}
      </form>
      {error && (
        <div
          className="border-b border-err/40 bg-err-bg px-4 py-1.5 text-[12px] text-err"
          role="alert"
        >
          {error}
        </div>
      )}
      {rules.isError ? (
        <ErrorState error={rules.error} retry={() => rules.refetch()} />
      ) : !rules.data ? (
        <div className="space-y-1 p-3" aria-busy="true">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-7 w-full" />
          ))}
        </div>
      ) : rules.data.items.length === 0 ? (
        <EmptyState title="No alert rules yet">
          Add one above or with `shadow alerts add`. Rules are evaluated by the API on its timer and
          notify the webhook when they fire.
        </EmptyState>
      ) : (
        <table className="w-full border-collapse text-[12px]" data-testid="rule-table">
          <thead className="text-left text-[11px] uppercase tracking-wide text-fg-muted">
            <tr>
              <th className="px-4 py-1">Name</th>
              <th className="px-3 py-1">Condition</th>
              <th className="px-3 py-1">Scope</th>
              <th className="px-3 py-1">State</th>
              <th className="px-3 py-1">Last value</th>
              <th className="px-3 py-1" />
            </tr>
          </thead>
          <tbody>
            {rules.data.items.map((rule) => (
              <tr
                key={rule.id}
                className="border-t border-border"
                data-testid="rule-row"
                data-rule-name={rule.name}
              >
                <td className="px-4 py-1.5 font-medium">{rule.name}</td>
                <td className="px-3 py-1.5">
                  {METRIC_LABEL[rule.metric]}{" "}
                  {rule.mode === "baseline"
                    ? `≥ ${rule.threshold}× baseline`
                    : `≥ ${formatValue(rule.metric, rule.threshold)}`}{" "}
                  over {windowLabel(rule.windowMinutes)}
                  {rule.minTraces > 1 ? `, ${rule.minTraces}+ traces` : ""}
                  {rule.keepFiringMinutes > 0
                    ? `, held ${windowLabel(rule.keepFiringMinutes)}`
                    : ""}
                </td>
                <td className="px-3 py-1.5">
                  {rule.agent ?? <span className="text-fg-faint">every agent</span>}
                  {rule.project ? ` in ${rule.project}` : ""}
                  {rule.tag ? ` tagged ${rule.tag}` : ""}
                  {rule.tool ? ` calling ${rule.tool}` : ""}
                </td>
                <td className="px-3 py-1.5" data-testid="rule-state">
                  {!rule.enabled ? (
                    <Badge tone="muted">paused</Badge>
                  ) : rule.state === "firing" ? (
                    <Badge tone="err">firing</Badge>
                  ) : (
                    <Badge tone="ok">ok</Badge>
                  )}
                </td>
                <td className="px-3 py-1.5" title={rule.lastEvaluatedAt ?? ""}>
                  {formatValue(rule.metric, rule.lastValue)}
                  {rule.lastEvaluatedAt ? (
                    <span className="text-fg-faint"> · {relativeTime(rule.lastEvaluatedAt)}</span>
                  ) : (
                    <span className="text-fg-faint"> · not evaluated yet</span>
                  )}
                </td>
                <td className="px-3 py-1.5 text-right whitespace-nowrap">
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => toggle.mutate(rule)}
                    data-testid="toggle-rule"
                  >
                    {rule.enabled ? "Pause" : "Resume"}
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => remove.mutate(rule)}
                    data-testid="delete-rule"
                  >
                    Delete
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <section className="border-t border-border" aria-labelledby="alert-history-heading">
        <h3
          id="alert-history-heading"
          className="px-4 pt-3 pb-1 text-[11px] font-semibold tracking-wide text-fg-muted uppercase"
        >
          History
        </h3>
        {history.isError ? (
          <ErrorState error={history.error} retry={() => history.refetch()} />
        ) : !history.data ? (
          <div className="space-y-1 p-3" aria-busy="true">
            {Array.from({ length: 2 }).map((_, i) => (
              <Skeleton key={i} className="h-6 w-full" />
            ))}
          </div>
        ) : transitions.length === 0 ? (
          <p className="px-4 pb-3 text-[12px] text-fg-muted" data-testid="alert-history-empty">
            No rule has fired yet. Each time one fires or resolves it is listed here, newest first.
          </p>
        ) : (
          <table className="w-full border-collapse text-[12px]" data-testid="alert-history">
            <thead className="text-left text-[11px] tracking-wide text-fg-muted uppercase">
              <tr>
                <th className="px-4 py-1">When</th>
                <th className="px-3 py-1">Rule</th>
                <th className="px-3 py-1">Event</th>
                <th className="px-3 py-1">Measured</th>
                <th className="px-3 py-1">Traces</th>
                <th className="px-3 py-1">Scope</th>
              </tr>
            </thead>
            <tbody>
              {transitions.map((t) => (
                <tr
                  key={t.id}
                  className="border-t border-border"
                  data-testid="alert-history-row"
                  data-rule-name={t.name}
                >
                  <td className="px-4 py-1.5 whitespace-nowrap text-fg-muted" title={t.at}>
                    {relativeTime(t.at)}
                  </td>
                  <td className="px-3 py-1.5 font-medium">{t.name}</td>
                  <td className="px-3 py-1.5">
                    <Badge tone={t.fired ? "err" : "ok"}>{t.fired ? "fired" : "resolved"}</Badge>
                  </td>
                  <td className="px-3 py-1.5">{describeTransition(t)}</td>
                  <td className="px-3 py-1.5">{t.traces ?? "–"}</td>
                  <td className="px-3 py-1.5">{t.scope}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </Dialog>
  );
}
