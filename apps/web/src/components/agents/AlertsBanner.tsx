"use client";

import { api } from "@/lib/api";
import { duration, money, relativeTime } from "@/lib/format";
import type { AlertRule } from "@shadow/schemas";
import { useQuery } from "@tanstack/react-query";

function formatValue(rule: AlertRule, value: number | null): string {
  if (value === null) return "–";
  if (rule.metric === "failure_rate") return `${Math.round(value * 100)}%`;
  if (rule.metric === "total_cost") return money(value);
  if (rule.metric === "p95_duration_ms") return duration(value);
  return String(value);
}

const METRIC_LABEL: Record<AlertRule["metric"], string> = {
  failure_rate: "failure rate",
  policy_violations: "policy violations",
  tool_errors: "tool errors",
  total_cost: "estimated cost",
  p95_duration_ms: "p95 duration",
};

function windowLabel(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

/**
 * Alert rules that are currently firing. Rules are managed with `shadow alerts` (or the API)
 * and evaluated by the API on a timer; this strip only reports their state.
 */
export function AlertsBanner() {
  const rules = useQuery({
    queryKey: ["alert-rules"],
    queryFn: api.alertRules,
    refetchInterval: 30_000,
    retry: false,
  });
  const items = rules.data?.items ?? [];
  const firing = items.filter((r) => r.enabled && r.state === "firing");
  if (items.length === 0) return null;
  if (firing.length === 0) {
    return (
      <div
        className="border-b border-border px-3 py-1.5 text-[11px] text-fg-muted"
        data-testid="alerts-ok"
      >
        ✓ {items.filter((r) => r.enabled).length} alert rule
        {items.filter((r) => r.enabled).length === 1 ? "" : "s"} within thresholds
      </div>
    );
  }
  return (
    <ul
      className="border-b border-err/40 bg-err-bg px-3 py-1.5 text-[12px]"
      role="status"
      aria-label="Firing alerts"
      data-testid="alerts-firing"
    >
      {firing.map((r) => (
        <li key={r.id} className="flex flex-wrap items-baseline gap-x-2" data-testid="alert-row">
          <span className="font-semibold text-err" aria-hidden="true">
            ▲
          </span>
          <span className="font-semibold">Firing: {r.name}</span>
          <span>
            {METRIC_LABEL[r.metric]} {formatValue(r, r.lastValue)} (threshold{" "}
            {formatValue(r, r.threshold)}) over the last {windowLabel(r.windowMinutes)}
            {r.agent ? ` for ${r.agent}` : ""}
          </span>
          <span className="text-fg-muted">
            {r.lastTraces ?? 0} trace{r.lastTraces === 1 ? "" : "s"}
            {r.lastTriggeredAt ? `, since ${relativeTime(r.lastTriggeredAt)}` : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}
