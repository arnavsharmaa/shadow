"use client";

import { api, type OverviewTotals } from "@/lib/api";
import { compact, duration, money, percent, relativeTime } from "@/lib/format";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AlertsBanner } from "../agents/AlertsBanner";
import { ColumnChart } from "../charts/ColumnChart";
import { Badge, EmptyState, ErrorState, Skeleton, outcomeTone } from "../ui/primitives";

const RANGES = [7, 14, 30] as const;

interface TileSpec {
  key: keyof OverviewTotals;
  label: string;
  format: (value: number | null) => string;
  /** Whether a rise is good news; `null` for neutral measures such as volume. */
  upIsGood: boolean | null;
}

const TILES: TileSpec[] = [
  { key: "traces", label: "Traces", format: (v) => compact(v), upIsGood: null },
  {
    key: "failureRate",
    label: "Failure rate",
    format: (v) => (v === null ? "–" : `${Math.round(v * 100)}%`),
    upIsGood: false,
  },
  {
    key: "policyViolations",
    label: "Policy violations",
    format: (v) => compact(v),
    upIsGood: false,
  },
  { key: "toolErrors", label: "Tool errors", format: (v) => compact(v), upIsGood: false },
  { key: "totalEstimatedCost", label: "Estimated cost", format: (v) => money(v), upIsGood: false },
  { key: "p95DurationMs", label: "p95 duration", format: (v) => duration(v), upIsGood: false },
];

/** Signed change against the previous period, coloured by direction and whether up is good. */
function Delta({
  current,
  previous,
  upIsGood,
}: {
  current: number | null;
  previous: number | null;
  upIsGood: boolean | null;
}) {
  if (current === null || previous === null || previous === 0) {
    return <span className="text-[11px] text-fg-faint">no previous period</span>;
  }
  const change = (current - previous) / previous;
  if (Math.abs(change) < 0.005) return <span className="text-[11px] text-fg-muted">unchanged</span>;
  const up = change > 0;
  const tone = upIsGood === null ? "text-fg-muted" : up === upIsGood ? "text-ok" : "text-err";
  return (
    <span className={`text-[11px] ${tone}`} data-testid="tile-delta">
      {up ? "▲" : "▼"} {percent(Math.abs(change), 0).replace(/^[+-]/, "")} vs previous period
    </span>
  );
}

/** Cross-agent dashboard: totals with deltas, daily volume and failures, busiest agents. */
export function Overview() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const days = RANGES.find((d) => String(d) === params.get("days")) ?? 14;
  const project = params.get("project") ?? undefined;
  // `to` pins the window's end (ISO time) for looking at a past period; default: now.
  const to = params.get("to") ?? undefined;
  const data = useQuery({
    queryKey: ["overview", days, project, to],
    queryFn: () => api.overview({ days, project, to }),
    refetchInterval: to ? false : 60_000,
  });
  const facets = useQuery({ queryKey: ["facets"], queryFn: api.facets });
  const models = useQuery({
    queryKey: ["overview-models", project, data.data?.from],
    queryFn: () => api.modelStats({ project, from: data.data?.from, to: data.data?.to }),
    enabled: data.data !== undefined,
  });
  const tools = useQuery({
    queryKey: ["overview-tools", project, data.data?.from],
    queryFn: () => api.toolStats({ project, from: data.data?.from, to: data.data?.to }),
    enabled: data.data !== undefined,
  });
  const failures = useQuery({
    queryKey: ["overview-failures", project, data.data?.from],
    queryFn: () =>
      api.listTraces({
        status: "failed",
        project,
        from: data.data?.from,
        to: data.data?.to,
        limit: 5,
      }),
    enabled: data.data !== undefined,
  });

  const setParam = (key: string, value: string | undefined) => {
    const next = new URLSearchParams(params.toString());
    if (!value || value === "all") next.delete(key);
    else next.set(key, value);
    router.replace(`${pathname}?${next.toString()}`);
  };

  return (
    <div className="flex h-full flex-col" data-testid="overview">
      <div className="flex flex-wrap items-center gap-3 border-b border-border bg-panel px-3 py-2 text-[12px]">
        <h1 className="text-[13px] font-semibold">Overview</h1>
        <label className="flex items-center gap-1 text-[11px] text-fg-muted">
          Last
          <select
            value={days}
            onChange={(e) => setParam("days", e.target.value)}
            className="h-7 rounded border border-border bg-bg px-1 text-[12px] text-fg"
            data-testid="overview-days"
          >
            {RANGES.map((d) => (
              <option key={d} value={d}>
                {d} days
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
            data-testid="overview-project"
          >
            <option value="all">All projects</option>
            {(facets.data?.projects ?? []).map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        {data.data && (
          <span className="ml-auto text-[11px] text-fg-faint">
            {data.data.totals.agents} agent{data.data.totals.agents === 1 ? "" : "s"} active;
            compared with the {days} days before
          </span>
        )}
      </div>
      <AlertsBanner />
      <div className="min-h-0 flex-1 overflow-auto p-3 text-[12px]">
        {data.isError ? (
          <ErrorState error={data.error} retry={() => data.refetch()} />
        ) : !data.data ? (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6" aria-busy="true">
            {TILES.map((t) => (
              <Skeleton key={t.key} className="h-20 w-full" />
            ))}
          </div>
        ) : data.data.totals.traces === 0 && data.data.previous.traces === 0 ? (
          <EmptyState title="No traces in this period">
            Widen the range or record some traces with the SDK.
          </EmptyState>
        ) : (
          <>
            <dl
              className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6"
              data-testid="overview-tiles"
            >
              {TILES.map((tile, index) => {
                const current = data.data.totals[tile.key];
                const previous = data.data.previous[tile.key];
                return (
                  <div
                    key={tile.key}
                    className="rounded border border-border bg-panel p-3"
                    data-testid="stat-tile"
                    data-metric={tile.key}
                  >
                    <dt className="text-[11px] text-fg-muted">{tile.label}</dt>
                    {/* The first tile is the hero figure: the one number the page leads with. */}
                    <dd
                      className={`${index === 0 ? "text-[32px]" : "text-[20px]"} font-semibold leading-tight`}
                      data-testid="tile-value"
                    >
                      {tile.format(current)}
                    </dd>
                    <dd>
                      <Delta current={current} previous={previous} upIsGood={tile.upIsGood} />
                    </dd>
                  </div>
                );
              })}
            </dl>
            <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
              <section className="rounded border border-border bg-panel p-3">
                <h2 className="mb-1 text-[12px] font-semibold">Traces per day (UTC)</h2>
                <ColumnChart
                  points={data.data.daily}
                  metric="traces"
                  bucket="day"
                  label="Traces"
                  height={160}
                  testId="overview-traces"
                />
              </section>
              <section className="rounded border border-border bg-panel p-3">
                <h2 className="mb-1 text-[12px] font-semibold">Failed traces per day (UTC)</h2>
                <ColumnChart
                  points={data.data.daily}
                  metric="failed"
                  bucket="day"
                  label="Failed traces"
                  height={160}
                  testId="overview-failed"
                />
              </section>
            </div>
            <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
              <section className="rounded border border-border bg-panel" data-testid="top-agents">
                <h2 className="border-b border-border px-3 py-2 text-[12px] font-semibold">
                  Busiest agents{" "}
                  <Link href="/agents" className="font-normal text-accent hover:underline">
                    all agents
                  </Link>
                </h2>
                <table className="w-full border-collapse">
                  <thead className="text-left text-[11px] uppercase tracking-wide text-fg-muted">
                    <tr>
                      <th className="px-3 py-1">Agent</th>
                      <th className="px-3 py-1 text-right">Traces</th>
                      <th className="px-3 py-1 text-right">Failed</th>
                      <th className="px-3 py-1 text-right">p95</th>
                      <th className="px-3 py-1 text-right">Est. cost</th>
                    </tr>
                  </thead>
                  <tbody className="tabular">
                    {data.data.topAgents.map((a) => (
                      <tr key={a.agentId} className="border-t border-border">
                        <td className="px-3 py-1">
                          <Link
                            href={`/?agent=${encodeURIComponent(a.agentSlug)}`}
                            className="text-accent hover:underline"
                          >
                            {a.agentName}
                          </Link>
                          <span className="ml-2 text-fg-faint">{a.projectName}</span>
                        </td>
                        <td className="px-3 py-1 text-right">{a.traces}</td>
                        <td className="px-3 py-1 text-right">{a.failed}</td>
                        <td className="px-3 py-1 text-right">{duration(a.p95DurationMs)}</td>
                        <td className="px-3 py-1 text-right">{money(a.totalEstimatedCost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
              <section
                className="rounded border border-border bg-panel"
                data-testid="overview-models"
              >
                <h2 className="border-b border-border px-3 py-2 text-[12px] font-semibold">
                  Models{" "}
                  <Link href="/settings" className="font-normal text-accent hover:underline">
                    prices
                  </Link>
                </h2>
                {models.data && models.data.items.length === 0 ? (
                  <p className="px-3 py-2 text-fg-muted">No model calls in this period.</p>
                ) : (
                  <table className="w-full border-collapse">
                    <thead className="text-left text-[11px] uppercase tracking-wide text-fg-muted">
                      <tr>
                        <th className="px-3 py-1">Model</th>
                        <th className="px-3 py-1 text-right">Calls</th>
                        <th className="px-3 py-1 text-right">Traces</th>
                        <th className="px-3 py-1 text-right">Tokens</th>
                        <th className="px-3 py-1 text-right">Est. cost</th>
                      </tr>
                    </thead>
                    <tbody className="tabular">
                      {(models.data?.items ?? []).map((m) => (
                        <tr
                          key={`${m.provider}:${m.model}`}
                          className="border-t border-border"
                          data-model={m.model}
                        >
                          <td className="px-3 py-1">
                            <span className="font-mono text-[11px]">{m.model}</span>
                            <span className="ml-2 text-fg-faint">{m.provider}</span>
                            {m.pricedCalls < m.calls && (
                              <span
                                className="ml-2 text-warn"
                                title={`${m.calls - m.pricedCalls} of ${m.calls} calls have no cost estimate; add a price with SHADOW_PRICING_FILE`}
                              >
                                unpriced
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-1 text-right">{m.calls}</td>
                          <td className="px-3 py-1 text-right">{m.traces}</td>
                          <td className="px-3 py-1 text-right">{m.totalTokens.toLocaleString()}</td>
                          <td className="px-3 py-1 text-right">{money(m.estimatedCost)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>
              <section
                className="rounded border border-border bg-panel"
                data-testid="overview-tools"
              >
                <h2 className="border-b border-border px-3 py-2 text-[12px] font-semibold">
                  Tools
                </h2>
                {tools.data && tools.data.items.length === 0 ? (
                  <p className="px-3 py-2 text-fg-muted">No tool calls in this period.</p>
                ) : (
                  <table className="w-full border-collapse">
                    <thead className="text-left text-[11px] uppercase tracking-wide text-fg-muted">
                      <tr>
                        <th className="px-3 py-1">Tool</th>
                        <th className="px-3 py-1 text-right">Calls</th>
                        <th className="px-3 py-1 text-right">Errors</th>
                        <th className="px-3 py-1 text-right">p95</th>
                      </tr>
                    </thead>
                    <tbody className="tabular">
                      {(tools.data?.items ?? []).map((t) => (
                        <tr key={t.tool} className="border-t border-border" data-tool={t.tool}>
                          <td className="px-3 py-1">
                            <Link
                              href={`/?tool=${encodeURIComponent(t.tool)}${project ? `&project=${encodeURIComponent(project)}` : ""}`}
                              className="font-mono text-[11px] hover:underline"
                            >
                              {t.tool}
                            </Link>
                            {t.blocked > 0 && (
                              <span
                                className="ml-2 text-warn"
                                title={`${t.blocked} of ${t.calls} calls were blocked by a guard policy`}
                              >
                                {t.blocked} blocked
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-1 text-right">{t.calls}</td>
                          <td className={`px-3 py-1 text-right ${t.errors > 0 ? "text-err" : ""}`}>
                            {t.errors > 0 ? (
                              <Link
                                href={`/?toolError=${encodeURIComponent(t.tool)}${project ? `&project=${encodeURIComponent(project)}` : ""}`}
                                className="hover:underline"
                                title="The traces in which this tool failed"
                              >
                                {t.errors}
                              </Link>
                            ) : (
                              t.errors
                            )}
                            {t.errors > 0 && (
                              <span className="ml-1 text-fg-faint">
                                ({(t.errorRate * 100).toFixed(1)}%)
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-1 text-right">{duration(t.p95DurationMs)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>
              <section
                className="rounded border border-border bg-panel"
                data-testid="recent-failures"
              >
                <h2 className="border-b border-border px-3 py-2 text-[12px] font-semibold">
                  Recent failures{" "}
                  <Link
                    href={`/?status=failed${project ? `&project=${encodeURIComponent(project)}` : ""}`}
                    className="font-normal text-accent hover:underline"
                  >
                    all failed traces
                  </Link>
                </h2>
                {failures.data && failures.data.items.length === 0 ? (
                  <p className="px-3 py-2 text-fg-muted">No failed traces in this period.</p>
                ) : (
                  <ul className="divide-y divide-border">
                    {(failures.data?.items ?? []).map((trace) => (
                      <li key={trace.id} className="flex items-center gap-2 px-3 py-1.5">
                        <Link
                          href={`/traces/${encodeURIComponent(trace.id)}`}
                          className="min-w-0 flex-1 truncate text-accent hover:underline"
                        >
                          {trace.name}
                        </Link>
                        {trace.outcome && (
                          <Badge tone={outcomeTone(trace.outcome.kind)}>
                            {trace.outcome.label}
                          </Badge>
                        )}
                        <span className="mono text-fg-faint">{trace.agentSlug}</span>
                        <span className="whitespace-nowrap text-fg-faint">
                          {relativeTime(trace.startedAt)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
