"use client";

import { api } from "@/lib/api";
import { classNames } from "@/lib/format";
import type { ShadowEvent } from "@shadow/schemas";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { JsonView } from "../json/JsonView";
import { ErrorState, Skeleton } from "../ui/primitives";
import { DiffTable } from "./DiffTable";

type Tab = "context" | "state" | "diff";

/** What did the agent know at this moment? Context, state, and what changed. */
export function StateInspector({
  traceId,
  branchId,
  event,
}: {
  traceId: string;
  branchId: string;
  event: ShadowEvent | null;
}) {
  const [tab, setTab] = useState<Tab>("context");
  const [moment, setMoment] = useState<"before" | "after">("after");
  const query = useQuery({
    queryKey: ["event-state", traceId, branchId, event?.id],
    queryFn: () => api.eventState(traceId, event?.id ?? "", branchId),
    enabled: event !== null,
  });

  if (!event)
    return (
      <p className="p-3 text-[12px] text-fg-muted">
        Select an event to see the state at that moment.
      </p>
    );
  if (query.isError) return <ErrorState error={query.error} retry={() => query.refetch()} />;
  if (!query.data) {
    return (
      <div className="space-y-2 p-3" aria-busy="true">
        <Skeleton className="h-6 w-1/2" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  const snapshot = moment === "before" ? query.data.before : query.data.after;
  const changed = query.data.stateDiff.length + query.data.contextDiff.length;

  return (
    <div className="flex h-full flex-col" data-testid="state-inspector">
      <div className="flex items-center gap-1 border-b border-border px-2 py-1 text-[11px]">
        {(["context", "state", "diff"] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            aria-pressed={tab === t}
            data-testid={`inspector-tab-${t}`}
            className={classNames(
              "rounded px-2 py-0.5 capitalize",
              tab === t ? "bg-muted text-fg" : "text-fg-muted hover:text-fg",
            )}
          >
            {t}
            {t === "diff" && changed > 0 && (
              <span className="ml-1 rounded bg-warn-bg px-1 text-warn">{changed}</span>
            )}
          </button>
        ))}
        {tab !== "diff" && (
          <span className="ml-auto flex items-center gap-1" role="group" aria-label="Moment">
            <button
              type="button"
              onClick={() => setMoment("before")}
              aria-pressed={moment === "before"}
              className={classNames(
                "rounded px-1.5",
                moment === "before" ? "bg-muted text-fg" : "text-fg-muted",
              )}
            >
              before
            </button>
            <button
              type="button"
              onClick={() => setMoment("after")}
              aria-pressed={moment === "after"}
              className={classNames(
                "rounded px-1.5",
                moment === "after" ? "bg-muted text-fg" : "text-fg-muted",
              )}
            >
              after
            </button>
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {tab === "context" && (
          <>
            <ContextList context={snapshot.context} />
            <JsonView
              label={`Context ${moment} #${event.sequence}`}
              value={snapshot.context}
              className="mt-2"
              testId="context-json"
            />
          </>
        )}
        {tab === "state" && (
          <>
            <p className="mb-1 text-[11px] text-fg-muted">
              state version {snapshot.stateVersion} · as of sequence {snapshot.asOfSequence}
              {snapshot.fromSnapshotSequence !== null &&
                ` · from snapshot @${snapshot.fromSnapshotSequence} (+${snapshot.appliedEvents} events)`}
            </p>
            <JsonView
              label={`State ${moment} #${event.sequence}`}
              value={snapshot.state}
              defaultExpandDepth={2}
              testId="state-json"
            />
          </>
        )}
        {tab === "diff" && (
          <div className="space-y-3">
            <div>
              <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
                Context changes
              </h3>
              <DiffTable
                entries={query.data.contextDiff}
                emptyLabel="Context unchanged by this event"
                testId="context-diff"
              />
            </div>
            <div>
              <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
                State changes
              </h3>
              <DiffTable
                entries={query.data.stateDiff}
                emptyLabel="State unchanged by this event"
                testId="state-diff"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ContextList({ context }: { context: Record<string, unknown> }) {
  const entries = Object.entries(context);
  if (entries.length === 0)
    return <p className="text-[12px] text-fg-faint">No context values yet.</p>;
  return (
    <table className="w-full border-collapse text-[12px]" data-testid="context-table">
      <tbody>
        {entries.map(([key, value]) => (
          <tr key={key} className="border-b border-border align-top" data-context-key={key}>
            <td className="mono w-1/3 px-1 py-0.5 text-fg-muted">{key}</td>
            <td className="mono px-1 py-0.5 break-all" data-testid={`context-value-${key}`}>
              {typeof value === "string" ? value : JSON.stringify(value)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
