"use client";

import { api } from "@/lib/api";
import { describeAudit } from "@/lib/audit";
import { relativeTime } from "@/lib/format";
import { useQuery } from "@tanstack/react-query";
import { Badge, EmptyState, ErrorState, Skeleton } from "../ui/primitives";

/** Who did what to this trace, newest first (from the API's audit log). */
export function ActivityList({ traceId }: { traceId: string }) {
  const activity = useQuery({
    queryKey: ["audit", traceId],
    queryFn: () => api.audit(traceId),
  });
  if (activity.isError)
    return <ErrorState error={activity.error} retry={() => activity.refetch()} />;
  if (!activity.data) {
    return (
      <div className="space-y-1 p-2" aria-busy="true">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </div>
    );
  }
  const items = activity.data.items;
  if (items.length === 0) {
    return (
      <EmptyState title="No activity yet">
        Forks, replays, renames, comparisons and notes on this trace show up here.
      </EmptyState>
    );
  }
  return (
    <ul className="divide-y divide-border text-[12px]" data-testid="activity-list">
      {items.map((e) => (
        <li key={e.id} className="flex items-start gap-2 px-3 py-2" data-testid="activity-row">
          <Badge tone={e.action.endsWith(".deleted") ? "err" : "muted"}>{e.actor}</Badge>
          <div className="min-w-0 flex-1">
            <div className="truncate">{describeAudit(e)}</div>
            <div className="mono text-[10px] text-fg-faint">
              {e.action} · {relativeTime(e.at)}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
