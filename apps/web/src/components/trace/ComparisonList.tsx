"use client";

import { api } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import type { Comparison } from "@shadow/schemas";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Badge, EmptyState, ErrorState, Skeleton } from "../ui/primitives";

/** Saved comparisons involving this trace, newest first. */
export function ComparisonList({ traceId }: { traceId: string }) {
  const comparisons = useQuery({
    queryKey: ["comparisons", traceId],
    queryFn: () => api.comparisons(traceId),
  });
  if (comparisons.isError)
    return <ErrorState error={comparisons.error} retry={() => comparisons.refetch()} />;
  if (!comparisons.data) {
    return (
      <div className="space-y-1 p-2" aria-busy="true">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    );
  }
  const items = comparisons.data.items;
  if (items.length === 0) {
    return (
      <EmptyState title="No comparisons yet">
        Fork an event and run the counterfactual, or tick two traces in the explorer, to create one.
      </EmptyState>
    );
  }
  return (
    <ul className="divide-y divide-border" data-testid="comparison-list">
      {items.map((c) => (
        <ComparisonRow key={c.id} comparison={c} traceId={traceId} />
      ))}
    </ul>
  );
}

function ComparisonRow({ comparison, traceId }: { comparison: Comparison; traceId: string }) {
  const r = comparison.result;
  const crossTrace = comparison.targetTraceId !== null && comparison.targetTraceId !== traceId;
  const otherTrace = comparison.traceId !== traceId;
  return (
    <li data-testid="comparison-row" data-comparison-id={comparison.id}>
      <Link
        href={`/traces/${encodeURIComponent(comparison.traceId)}/compare?comparison=${encodeURIComponent(comparison.id)}`}
        className="block px-3 py-2 text-[12px] hover:bg-hover"
        data-testid="comparison-link"
      >
        <div className="flex items-center gap-2">
          <span className="mono font-medium">{r.base.name}</span>
          <span className="text-fg-faint">vs</span>
          <span className="mono font-medium">{r.target.name}</span>
          {(crossTrace || otherTrace) && (
            <Badge tone="info" title="The other branch belongs to a different trace">
              cross-trace
            </Badge>
          )}
          <span className="ml-auto text-[11px] text-fg-faint" title={comparison.createdAt}>
            {relativeTime(comparison.createdAt)}
          </span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-fg-muted">
          <Badge tone={r.outcome.changed ? "warn" : "muted"}>
            {r.outcome.changed
              ? `outcome: ${r.outcome.base?.label ?? "-"} → ${r.outcome.target?.label ?? "-"}`
              : "same outcome"}
          </Badge>
          <span className="truncate" data-testid="comparison-divergence">
            {r.firstDivergence
              ? `diverges at #${r.firstDivergence.sequence}: ${r.firstDivergence.summary}`
              : "identical execution"}
          </span>
        </div>
      </Link>
    </li>
  );
}
