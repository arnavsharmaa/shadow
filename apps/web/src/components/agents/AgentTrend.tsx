"use client";

import { api, type AgentStatsRow } from "@/lib/api";
import { TREND_METRICS, metricValue, type TrendMetric } from "@/lib/trend";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ColumnChart } from "../charts/ColumnChart";
import { Button, EmptyState, ErrorState, Skeleton } from "../ui/primitives";

/** One agent's trend for one metric: a single-series column chart with hover and a table. */
export function AgentTrend({ agent, onClose }: { agent: AgentStatsRow; onClose: () => void }) {
  const [bucket, setBucket] = useState<"day" | "hour">("day");
  const [metric, setMetric] = useState<TrendMetric>("traces");
  const trend = useQuery({
    queryKey: ["agent-trend", agent.agentSlug, agent.projectSlug, bucket],
    // The window ends at the agent's latest run, so an idle agent still shows its history.
    queryFn: () =>
      api.agentTrend(agent.agentSlug, {
        bucket,
        project: agent.projectSlug,
        to: agent.lastStartedAt ?? undefined,
      }),
  });
  const label = TREND_METRICS.find((m) => m.key === metric)?.label ?? metric;

  const points = trend.data?.points ?? [];
  const max = Math.max(0, ...points.map((p) => metricValue(p, metric) ?? 0));

  return (
    <section className="border-t border-border p-3 text-[12px]" data-testid="agent-trend">
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <h2 className="text-[13px] font-semibold">
          {label} for <span className="mono">{agent.agentSlug}</span>
          <span className="font-normal text-fg-muted">
            {" "}
            per {bucket} (UTC), {bucket === "day" ? "30 days" : "48 hours"} up to the latest run
          </span>
        </h2>
        <label className="flex items-center gap-1 text-[11px] text-fg-muted">
          Metric
          <select
            value={metric}
            onChange={(e) => setMetric(e.target.value as TrendMetric)}
            className="h-7 rounded border border-border bg-bg px-1 text-[12px] text-fg"
            data-testid="trend-metric"
          >
            {TREND_METRICS.map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1 text-[11px] text-fg-muted">
          Bucket
          <select
            value={bucket}
            onChange={(e) => setBucket(e.target.value as "day" | "hour")}
            className="h-7 rounded border border-border bg-bg px-1 text-[12px] text-fg"
            data-testid="trend-bucket"
          >
            <option value="day">Day</option>
            <option value="hour">Hour</option>
          </select>
        </label>
        <Button size="xs" variant="ghost" className="ml-auto" onClick={onClose}>
          Close
        </Button>
      </div>
      {trend.isError ? (
        <ErrorState error={trend.error} retry={() => trend.refetch()} />
      ) : !trend.data ? (
        <Skeleton className="h-[200px] w-full" />
      ) : max === 0 ? (
        <EmptyState title="Nothing in this period">
          No {label.toLowerCase()} for this agent in the selected window.
        </EmptyState>
      ) : (
        <ColumnChart
          points={points}
          metric={metric}
          bucket={bucket}
          label={label}
          subject={agent.agentSlug}
        />
      )}
    </section>
  );
}
