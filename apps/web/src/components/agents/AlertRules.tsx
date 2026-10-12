"use client";

import { api, type AlertRuleInput } from "@/lib/api";
import { duration, money, relativeTime } from "@/lib/format";
import type { AlertMetric, AlertRule } from "@shadow/schemas";
import { ALERT_METRICS } from "@shadow/schemas";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Badge, Button, Dialog, EmptyState, ErrorState, Skeleton } from "../ui/primitives";

const METRIC_LABEL: Record<AlertMetric, string> = {
  failure_rate: "failure rate",
  policy_violations: "policy violations",
  tool_errors: "tool errors",
  total_cost: "estimated cost",
  p95_duration_ms: "p95 duration",
};

const METRIC_HELP: Record<AlertMetric, string> = {
  failure_rate: "a fraction between 0 and 1, e.g. 0.25 for 25%",
  policy_violations: "a count of violations in the window",
  tool_errors: "a count of tool errors in the window",
  total_cost: "US dollars over the window",
  p95_duration_ms: "milliseconds",
};

const WINDOWS: { minutes: number; label: string }[] = [
  { minutes: 15, label: "15 minutes" },
  { minutes: 60, label: "1 hour" },
  { minutes: 360, label: "6 hours" },
  { minutes: 1440, label: "1 day" },
  { minutes: 10080, label: "7 days" },
];

function formatValue(metric: AlertMetric, value: number | null): string {
  if (value === null) return "–";
  if (metric === "failure_rate") return `${Math.round(value * 100)}%`;
  if (metric === "total_cost") return money(value);
  if (metric === "p95_duration_ms") return duration(value);
  return String(value);
}

function windowLabel(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
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
  const [name, setName] = useState("");
  const [metric, setMetric] = useState<AlertMetric>("failure_rate");
  const [agent, setAgent] = useState("");
  const [mode, setMode] = useState<"threshold" | "baseline">("threshold");
  const [threshold, setThreshold] = useState("0.25");
  const [windowMinutes, setWindowMinutes] = useState(60);
  const [minTraces, setMinTraces] = useState("1");
  const [error, setError] = useState<string | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["alert-rules"] });
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  const create = useMutation({
    mutationFn: (body: AlertRuleInput) => api.createAlertRule(body),
    onSuccess: async () => {
      setName("");
      setError(null);
      await refresh();
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
          create.mutate({
            name: name.trim(),
            metric,
            threshold: thresholdValue,
            mode,
            windowMinutes,
            minTraces: Math.max(1, Number(minTraces) || 1),
            ...(agent.trim() ? { agent: agent.trim() } : {}),
          });
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
        <Button type="submit" variant="primary" disabled={!canCreate} data-testid="create-rule">
          Add rule
        </Button>
        <span className="basis-full text-[11px] text-fg-faint">
          {mode === "baseline"
            ? "Fires while the metric is at or above the multiplier times its average over the preceding windows."
            : `Fires while the metric is at or above the threshold: ${METRIC_HELP[metric]}.`}
        </span>
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
                </td>
                <td className="px-3 py-1.5">
                  {rule.agent ?? <span className="text-fg-faint">every agent</span>}
                  {rule.project ? ` in ${rule.project}` : ""}
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
    </Dialog>
  );
}
