"use client";

import { api, type TraceFilters } from "@/lib/api";
import { classNames, compact, dateTime, duration, money, relativeTime } from "@/lib/format";
import type { TraceSummary } from "@shadow/schemas";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Skeleton,
  outcomeTone,
  statusTone,
} from "../ui/primitives";

function readFilters(params: URLSearchParams): TraceFilters {
  const get = (k: string) => params.get(k) ?? undefined;
  return {
    project: get("project"),
    agent: get("agent"),
    status: get("status") as TraceFilters["status"],
    tag: get("tag"),
    tool: get("tool"),
    q: get("q"),
    from: get("from"),
    to: get("to"),
    minCost: get("minCost") ? Number(get("minCost")) : undefined,
    minDurationMs: get("minDurationMs") ? Number(get("minDurationMs")) : undefined,
    sort: (get("sort") as TraceFilters["sort"]) ?? "startedAt",
    order: (get("order") as TraceFilters["order"]) ?? "desc",
    cursor: get("cursor"),
    limit: 50,
  };
}

export function TraceExplorer() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const filters = useMemo(() => readFilters(params), [params]);
  const [search, setSearch] = useState(filters.q ?? "");

  const setFilter = useCallback(
    (patch: Partial<Record<string, string | undefined>>) => {
      const next = new URLSearchParams(params.toString());
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined || value === "") next.delete(key);
        else next.set(key, value);
      }
      if (!("cursor" in patch)) next.delete("cursor");
      router.replace(`${pathname}?${next.toString()}`);
    },
    [params, pathname, router],
  );

  const traces = useQuery({
    queryKey: ["traces", filters],
    queryFn: () => api.listTraces(filters),
  });
  const facets = useQuery({ queryKey: ["facets"], queryFn: api.facets });

  const toggleSort = (sort: NonNullable<TraceFilters["sort"]>) => {
    if (filters.sort === sort) setFilter({ order: filters.order === "asc" ? "desc" : "asc" });
    else setFilter({ sort, order: sort === "name" ? "asc" : "desc" });
  };

  const activeCount = [
    "project",
    "agent",
    "status",
    "tag",
    "tool",
    "q",
    "from",
    "to",
    "minCost",
    "minDurationMs",
  ].filter((k) => params.get(k)).length;

  return (
    <div className="flex h-full flex-col" data-testid="trace-explorer">
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-panel px-3 py-2">
        <form
          className="flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            setFilter({ q: search });
          }}
        >
          <label htmlFor="trace-search" className="sr-only">
            Search traces
          </label>
          <input
            id="trace-search"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search id, agent, tool, tag, customer id…"
            className="h-7 w-72 rounded border border-border bg-bg px-2 text-[12px] placeholder:text-fg-faint"
          />
          <Button type="submit" size="sm">
            Search
          </Button>
        </form>
        <Select
          label="Project"
          value={filters.project}
          onChange={(v) => setFilter({ project: v, agent: undefined })}
          options={(facets.data?.projects ?? []).map((p) => ({ value: p.slug, label: p.name }))}
        />
        <Select
          label="Agent"
          value={filters.agent}
          onChange={(v) => setFilter({ agent: v })}
          options={(facets.data?.agents ?? [])
            .filter((a) => !filters.project || a.projectSlug === filters.project)
            .map((a) => ({ value: a.slug, label: a.name }))}
        />
        <Select
          label="Status"
          value={filters.status}
          onChange={(v) => setFilter({ status: v })}
          options={[
            { value: "completed", label: "Completed" },
            { value: "failed", label: "Failed" },
            { value: "running", label: "Running" },
          ]}
        />
        <Select
          label="Tag"
          value={filters.tag}
          onChange={(v) => setFilter({ tag: v })}
          options={(facets.data?.tags ?? []).map((t) => ({ value: t, label: t }))}
        />
        <Select
          label="Tool"
          value={filters.tool}
          onChange={(v) => setFilter({ tool: v })}
          options={(facets.data?.tools ?? []).map((t) => ({ value: t, label: t }))}
        />
        <NumberInput
          label="Min cost ($)"
          value={filters.minCost}
          step="0.001"
          onChange={(v) => setFilter({ minCost: v })}
        />
        <NumberInput
          label="Min duration (ms)"
          value={filters.minDurationMs}
          step="100"
          onChange={(v) => setFilter({ minDurationMs: v })}
        />
        <DateInput label="From" value={filters.from} onChange={(v) => setFilter({ from: v })} />
        <DateInput label="To" value={filters.to} onChange={(v) => setFilter({ to: v })} />
        {activeCount > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearch("");
              router.replace(pathname);
            }}
          >
            Clear {activeCount} filter{activeCount === 1 ? "" : "s"}
          </Button>
        )}
        <span className="ml-auto text-[11px] text-fg-muted" aria-live="polite">
          {traces.data
            ? `${traces.data.total.toLocaleString()} trace${traces.data.total === 1 ? "" : "s"}`
            : ""}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {traces.isError ? (
          <ErrorState error={traces.error} retry={() => traces.refetch()} />
        ) : traces.isLoading ? (
          <div className="space-y-1 p-3" aria-busy="true" aria-label="Loading traces">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-7 w-full" />
            ))}
          </div>
        ) : traces.data && traces.data.items.length === 0 ? (
          <EmptyState title="No traces match these filters">
            Record one with the SDK (`pnpm --filter @shadow/example-refund-agent start`) or seed the
            demo data with `pnpm db:seed`.
          </EmptyState>
        ) : (
          <table
            className="w-full min-w-[1100px] border-collapse text-[12px]"
            data-testid="trace-table"
          >
            <thead className="sticky top-0 z-10 bg-panel text-left text-[11px] uppercase tracking-wide text-fg-muted">
              <tr>
                <Th>Project / Agent</Th>
                <Th
                  sortable
                  active={filters.sort === "name"}
                  order={filters.order}
                  onClick={() => toggleSort("name")}
                >
                  Trace
                </Th>
                <Th
                  sortable
                  active={filters.sort === "startedAt"}
                  order={filters.order}
                  onClick={() => toggleSort("startedAt")}
                >
                  Started
                </Th>
                <Th
                  sortable
                  active={filters.sort === "durationMs"}
                  order={filters.order}
                  onClick={() => toggleSort("durationMs")}
                  align="right"
                >
                  Duration
                </Th>
                <Th>Status</Th>
                <Th>Outcome</Th>
                <Th align="right">Model</Th>
                <Th align="right">Tools</Th>
                <Th
                  sortable
                  active={filters.sort === "totalTokens"}
                  order={filters.order}
                  onClick={() => toggleSort("totalTokens")}
                  align="right"
                >
                  Tokens
                </Th>
                <Th
                  sortable
                  active={filters.sort === "totalEstimatedCost"}
                  order={filters.order}
                  onClick={() => toggleSort("totalEstimatedCost")}
                  align="right"
                >
                  Est. cost
                </Th>
                <Th align="right">Branches</Th>
                <Th>Tags</Th>
              </tr>
            </thead>
            <tbody>
              {traces.data?.items.map((t) => (
                <TraceRow key={t.id} trace={t} />
              ))}
            </tbody>
          </table>
        )}
      </div>
      {traces.data && (traces.data.nextCursor || filters.cursor) && (
        <div className="flex items-center justify-end gap-2 border-t border-border bg-panel px-3 py-1.5 text-[11px]">
          <Button
            size="xs"
            disabled={!filters.cursor}
            onClick={() => setFilter({ cursor: undefined })}
          >
            First page
          </Button>
          <Button
            size="xs"
            disabled={!traces.data.nextCursor}
            onClick={() => setFilter({ cursor: traces.data?.nextCursor ?? undefined })}
          >
            Next page
          </Button>
        </div>
      )}
    </div>
  );
}

function TraceRow({ trace }: { trace: TraceSummary }) {
  return (
    <tr
      className="border-b border-border hover:bg-hover"
      data-testid="trace-row"
      data-trace-id={trace.id}
    >
      <td className="px-3 py-1.5 align-top">
        <div className="text-fg-muted">{trace.projectName}</div>
        <div>{trace.agentName}</div>
      </td>
      <td className="px-3 py-1.5 align-top">
        <Link
          href={`/traces/${encodeURIComponent(trace.id)}`}
          className="font-medium text-accent hover:underline"
          data-testid="trace-link"
        >
          {trace.name}
        </Link>
        <div className="mono text-fg-faint">{trace.id}</div>
      </td>
      <td className="px-3 py-1.5 align-top whitespace-nowrap" title={trace.startedAt}>
        <div>{dateTime(trace.startedAt)}</div>
        <div className="text-fg-faint">{relativeTime(trace.startedAt)}</div>
      </td>
      <td className="px-3 py-1.5 text-right align-top tabular">
        {duration(trace.durationMs ?? trace.metrics.durationMs)}
      </td>
      <td className="px-3 py-1.5 align-top">
        <Badge tone={statusTone(trace.status)}>{trace.status}</Badge>
      </td>
      <td className="max-w-[260px] px-3 py-1.5 align-top">
        {trace.outcome ? (
          <Badge tone={outcomeTone(trace.outcome.kind)} title={trace.outcome.summary}>
            <span className="truncate">{trace.outcome.label}</span>
          </Badge>
        ) : (
          <span className="text-fg-faint">–</span>
        )}
      </td>
      <td className="px-3 py-1.5 text-right align-top tabular">{trace.metrics.modelCalls}</td>
      <td className="px-3 py-1.5 text-right align-top tabular">
        {trace.metrics.toolCalls}
        {trace.metrics.toolErrors > 0 && (
          <span className="ml-1 text-err">({trace.metrics.toolErrors} err)</span>
        )}
      </td>
      <td
        className="px-3 py-1.5 text-right align-top tabular"
        title={`${trace.metrics.inputTokens} in / ${trace.metrics.outputTokens} out`}
      >
        {compact(trace.metrics.totalTokens)}
      </td>
      <td
        className="px-3 py-1.5 text-right align-top tabular"
        title="Estimated from the configured pricing table"
      >
        {money(trace.metrics.totalEstimatedCost, trace.metrics.currency)}
      </td>
      <td className="px-3 py-1.5 text-right align-top tabular">{trace.branchCount}</td>
      <td className="px-3 py-1.5 align-top">
        <div className="flex flex-wrap gap-1">
          {trace.tags.map((tag) => (
            <Badge key={tag} tone="muted">
              {tag}
            </Badge>
          ))}
        </div>
      </td>
    </tr>
  );
}

function Th({
  children,
  sortable,
  active,
  order,
  onClick,
  align = "left",
}: {
  children: React.ReactNode;
  sortable?: boolean;
  active?: boolean;
  order?: string;
  onClick?: () => void;
  align?: "left" | "right";
}) {
  const content = (
    <span className={classNames("inline-flex items-center gap-1", active && "text-fg")}>
      {children}
      {sortable && <span aria-hidden="true">{active ? (order === "asc" ? "▲" : "▼") : "↕"}</span>}
    </span>
  );
  return (
    <th
      scope="col"
      className={classNames(
        "border-b border-border px-3 py-1.5 font-semibold",
        align === "right" && "text-right",
      )}
    >
      {sortable ? (
        <button
          type="button"
          onClick={onClick}
          className="hover:text-fg"
          aria-sort={active ? (order === "asc" ? "ascending" : "descending") : "none"}
        >
          {content}
        </button>
      ) : (
        content
      )}
    </th>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string | undefined;
  onChange: (v: string | undefined) => void;
  options: { value: string; label: string }[];
}) {
  const id = `filter-${label.toLowerCase().replace(/\s+/g, "-")}`;
  return (
    <label htmlFor={id} className="flex items-center gap-1 text-[11px] text-fg-muted">
      {label}
      <select
        id={id}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || undefined)}
        className="h-7 rounded border border-border bg-bg px-1 text-[12px] text-fg"
      >
        <option value="">All</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function NumberInput({
  label,
  value,
  onChange,
  step,
}: {
  label: string;
  value: number | undefined;
  onChange: (v: string | undefined) => void;
  step: string;
}) {
  const id = `filter-${label.toLowerCase().replace(/[^a-z]+/g, "-")}`;
  return (
    <label htmlFor={id} className="flex items-center gap-1 text-[11px] text-fg-muted">
      {label}
      <input
        id={id}
        type="number"
        min={0}
        step={step}
        defaultValue={value ?? ""}
        onBlur={(e) => onChange(e.target.value || undefined)}
        className="h-7 w-24 rounded border border-border bg-bg px-1 text-[12px] text-fg"
      />
    </label>
  );
}

function DateInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string | undefined;
  onChange: (v: string | undefined) => void;
}) {
  const id = `filter-${label.toLowerCase()}`;
  return (
    <label htmlFor={id} className="flex items-center gap-1 text-[11px] text-fg-muted">
      {label}
      <input
        id={id}
        type="date"
        defaultValue={value ? value.slice(0, 10) : ""}
        onChange={(e) =>
          onChange(
            e.target.value
              ? new Date(
                  `${e.target.value}T${label === "To" ? "23:59:59.999" : "00:00:00.000"}Z`,
                ).toISOString()
              : undefined,
          )
        }
        className="h-7 rounded border border-border bg-bg px-1 text-[12px] text-fg"
      />
    </label>
  );
}
