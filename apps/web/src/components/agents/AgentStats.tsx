"use client";

import { api, type AgentStatsRow } from "@/lib/api";
import { dateTime, duration, money, percent, relativeTime } from "@/lib/format";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Badge, Button, EmptyState, ErrorState, Skeleton } from "../ui/primitives";
import { BatchDialog } from "./BatchDialog";

const RANGES: { key: string; label: string; days: number | null }[] = [
  { key: "24h", label: "Last 24 hours", days: 1 },
  { key: "7d", label: "Last 7 days", days: 7 },
  { key: "30d", label: "Last 30 days", days: 30 },
  { key: "all", label: "All time", days: null },
];

/** Per-agent overview: volume, failures, policy violations, latency, cost and tokens. */
export function AgentStats() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const rangeKey = params.get("range") ?? "all";
  const range = RANGES.find((r) => r.key === rangeKey) ?? (RANGES[3] as (typeof RANGES)[number]);
  const project = params.get("project") ?? undefined;
  const days = range.days;

  const stats = useQuery({
    queryKey: ["agent-stats", range.key, project],
    // The cutoff is computed when the query runs, not during render.
    queryFn: () =>
      api.agentStats({
        from: days === null ? undefined : new Date(Date.now() - days * 86_400_000).toISOString(),
        project,
      }),
    refetchInterval: 30_000,
  });
  const facets = useQuery({ queryKey: ["facets"], queryFn: api.facets });
  const health = useQuery({ queryKey: ["health"], queryFn: api.health, staleTime: 60_000 });
  const replayable = new Set(health.data?.agents?.replayable ?? []);
  const [batchAgent, setBatchAgent] = useState<AgentStatsRow | null>(null);

  const setParam = (key: string, value: string | undefined) => {
    const next = new URLSearchParams(params.toString());
    if (!value || value === "all") next.delete(key);
    else next.set(key, value);
    router.replace(`${pathname}?${next.toString()}`);
  };

  return (
    <div className="flex h-full flex-col" data-testid="agent-stats">
      <div className="flex flex-wrap items-center gap-3 border-b border-border bg-panel px-3 py-2 text-[12px]">
        <h1 className="text-[13px] font-semibold">Agents</h1>
        <label className="flex items-center gap-1 text-[11px] text-fg-muted">
          Range
          <select
            value={range.key}
            onChange={(e) => setParam("range", e.target.value)}
            className="h-7 rounded border border-border bg-bg px-1 text-[12px] text-fg"
            data-testid="agent-range"
          >
            {RANGES.map((r) => (
              <option key={r.key} value={r.key}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1 text-[11px] text-fg-muted">
          Project
          <select
            value={project ?? "all"}
            onChange={(e) => setParam("project", e.target.value)}
            className="h-7 rounded border border-border bg-bg px-1 text-[12px] text-fg"
            data-testid="agent-project"
          >
            <option value="all">All projects</option>
            {(facets.data?.projects ?? []).map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        {stats.data && (
          <span className="ml-auto text-[11px] text-fg-faint">
            {stats.data.items.reduce((sum, a) => sum + a.traces, 0)} traces across{" "}
            {stats.data.items.length} agent{stats.data.items.length === 1 ? "" : "s"}
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {stats.isError ? (
          <ErrorState error={stats.error} retry={() => stats.refetch()} />
        ) : !stats.data ? (
          <div className="space-y-1 p-3" aria-busy="true" aria-label="Loading agent statistics">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        ) : stats.data.items.length === 0 ? (
          <EmptyState title="No traces in this range">
            Widen the range or record some traces with the SDK.
          </EmptyState>
        ) : (
          <table
            className="w-full min-w-[1000px] border-collapse text-[12px]"
            data-testid="agent-table"
          >
            <thead className="sticky top-0 z-10 bg-panel text-left text-[11px] uppercase tracking-wide text-fg-muted">
              <tr>
                <th className="px-3 py-1.5">Agent</th>
                <th className="px-3 py-1.5">Project</th>
                <th className="px-3 py-1.5 text-right">Traces</th>
                <th className="px-3 py-1.5 text-right">Failed</th>
                <th className="px-3 py-1.5 text-right">Policy violations</th>
                <th className="px-3 py-1.5 text-right">Tool errors</th>
                <th className="px-3 py-1.5 text-right">Avg duration</th>
                <th className="px-3 py-1.5 text-right">p95</th>
                <th className="px-3 py-1.5 text-right">Est. cost</th>
                <th className="px-3 py-1.5 text-right">Avg cost</th>
                <th className="px-3 py-1.5 text-right">Tokens</th>
                <th className="px-3 py-1.5">Last run</th>
                <th className="px-3 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {stats.data.items.map((a) => (
                <AgentRow
                  key={a.agentId}
                  row={a}
                  onWhatIf={replayable.has(a.agentSlug) ? () => setBatchAgent(a) : undefined}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
      {batchAgent && (
        <BatchDialog
          key={batchAgent.agentId}
          open
          onClose={() => {
            setBatchAgent(null);
            void stats.refetch();
          }}
          agent={batchAgent}
          tools={facets.data?.tools ?? []}
        />
      )}
    </div>
  );
}

function AgentRow({ row, onWhatIf }: { row: AgentStatsRow; onWhatIf?: () => void }) {
  const failureRate = row.traces > 0 ? row.failed / row.traces : 0;
  return (
    <tr
      className="border-b border-border hover:bg-hover"
      data-testid="agent-row"
      data-agent-slug={row.agentSlug}
    >
      <td className="px-3 py-1.5 align-top">
        <Link
          href={`/?agent=${encodeURIComponent(row.agentSlug)}`}
          className="font-medium text-accent hover:underline"
          data-testid="agent-link"
        >
          {row.agentName}
        </Link>
        <div className="mono text-fg-faint">{row.agentSlug}</div>
      </td>
      <td className="px-3 py-1.5 align-top">{row.projectName}</td>
      <td className="px-3 py-1.5 text-right align-top tabular">{row.traces}</td>
      <td className="px-3 py-1.5 text-right align-top tabular">
        {row.failed > 0 ? (
          <Badge tone="err" title={`${percent(failureRate * 100, 0)} of traces`}>
            {row.failed}
          </Badge>
        ) : (
          <span className="text-fg-faint">0</span>
        )}
      </td>
      <td
        className="px-3 py-1.5 text-right align-top tabular"
        data-testid="agent-policy-violations"
      >
        {row.policyViolations > 0 ? (
          <Badge tone="warn">{row.policyViolations}</Badge>
        ) : (
          <span className="text-fg-faint">0</span>
        )}
      </td>
      <td className="px-3 py-1.5 text-right align-top tabular">{row.toolErrors}</td>
      <td className="px-3 py-1.5 text-right align-top tabular">{duration(row.avgDurationMs)}</td>
      <td className="px-3 py-1.5 text-right align-top tabular">{duration(row.p95DurationMs)}</td>
      <td className="px-3 py-1.5 text-right align-top tabular">{money(row.totalEstimatedCost)}</td>
      <td className="px-3 py-1.5 text-right align-top tabular">{money(row.avgEstimatedCost)}</td>
      <td className="px-3 py-1.5 text-right align-top tabular">{row.totalTokens}</td>
      <td className="px-3 py-1.5 align-top whitespace-nowrap" title={row.lastStartedAt ?? ""}>
        {row.lastStartedAt ? (
          <>
            <div>{dateTime(row.lastStartedAt)}</div>
            <div className="text-fg-faint">{relativeTime(row.lastStartedAt)}</div>
          </>
        ) : (
          "–"
        )}
      </td>
      <td className="px-3 py-1.5 text-right align-top">
        {onWhatIf && (
          <Button
            size="xs"
            onClick={onWhatIf}
            title="Re-run this agent's recorded traces with one context value changed"
            data-testid="what-if"
          >
            What if…
          </Button>
        )}
      </td>
    </tr>
  );
}
