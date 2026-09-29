"use client";

import { ApiRequestError, api, apiBaseUrl } from "@/lib/api";
import { dateTime, duration, money } from "@/lib/format";
import { branchEvents } from "@/lib/shared";
import { buildEventTree, flattenTree } from "@shadow/core";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { JsonView } from "../json/JsonView";
import {
  Badge,
  EmptyState,
  ErrorState,
  KeyValue,
  Panel,
  Skeleton,
  eventTone,
  outcomeTone,
  statusTone,
} from "../ui/primitives";

/**
 * Read-only view of a trace shared through a link. Everything comes from the link's bundle:
 * no other API call is made, so it works for people without an API token.
 */
export function SharedTrace({ token }: { token: string }) {
  const shared = useQuery({
    queryKey: ["shared", token],
    queryFn: () => api.sharedTrace(token),
    retry: false,
  });
  const [branchId, setBranchId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const bundle = shared.data;
  const currentBranchId = branchId ?? bundle?.trace.rootBranchId ?? null;
  const rows = useMemo(
    () =>
      bundle && currentBranchId
        ? flattenTree(buildEventTree(branchEvents(bundle, currentBranchId)))
        : [],
    [bundle, currentBranchId],
  );

  if (shared.isError) {
    if (shared.error instanceof ApiRequestError && shared.error.status === 404) {
      return (
        <div className="p-6" data-testid="shared-unavailable">
          <EmptyState title="This link has expired or was revoked">
            Share links stop working after their expiry date or when their owner revokes them. Ask
            for a new one.
          </EmptyState>
        </div>
      );
    }
    return <ErrorState error={shared.error} retry={() => shared.refetch()} />;
  }
  if (!bundle) {
    return (
      <div className="space-y-2 p-4" aria-busy="true">
        <Skeleton className="h-10 w-2/3" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const { trace } = bundle;
  const selected = rows.find((r) => r.event.id === selectedId)?.event ?? rows[0]?.event ?? null;
  const shareUrl = `${apiBaseUrl()}/api/v1/shared/${token}`;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="shared-trace">
      <header className="border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="info">read-only</Badge>
          <h1 className="text-[15px] font-semibold" data-testid="shared-trace-name">
            {trace.name}
          </h1>
          <Badge tone={statusTone(trace.status)}>{trace.status}</Badge>
          {trace.outcome && (
            <Badge tone={outcomeTone(trace.outcome.kind)}>{trace.outcome.label}</Badge>
          )}
        </div>
        <dl className="mt-2 grid grid-cols-1 gap-x-6 md:grid-cols-3">
          <KeyValue label="Agent" mono>
            {bundle.project.slug} / {bundle.agent.slug}
          </KeyValue>
          <KeyValue label="Started">{dateTime(trace.startedAt)}</KeyValue>
          <KeyValue label="Duration">{duration(trace.durationMs)}</KeyValue>
          <KeyValue label="Events">{trace.metrics.eventCount}</KeyValue>
          <KeyValue label="Tokens">{trace.metrics.totalTokens}</KeyValue>
          <KeyValue label="Est. cost">{money(trace.metrics.totalEstimatedCost)}</KeyValue>
        </dl>
        <p className="mt-2 text-[11px] text-fg-muted">
          To fork, replay or compare it, import it into your own Shadow:{" "}
          <code className="mono select-all" data-testid="shared-import-command">
            shadow traces import {shareUrl}
          </code>
        </p>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <Panel
          title="Execution"
          className="border-0 border-r"
          actions={
            bundle.branches.length > 1 ? (
              <select
                aria-label="Branch"
                value={currentBranchId ?? ""}
                onChange={(e) => {
                  setBranchId(e.target.value);
                  setSelectedId(null);
                }}
                className="h-6 rounded border border-border bg-bg px-1 text-[11px]"
                data-testid="shared-branch"
              >
                {bundle.branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                    {b.outcome ? ` (${b.outcome.label})` : ""}
                  </option>
                ))}
              </select>
            ) : undefined
          }
        >
          <ol role="listbox" aria-label="Events" data-testid="shared-events">
            {rows.map(({ event, depth }) => (
              <li key={event.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={selected?.id === event.id}
                  onClick={() => setSelectedId(event.id)}
                  className={`flex w-full items-center gap-2 px-2 py-1 text-left text-[12px] hover:bg-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${selected?.id === event.id ? "bg-selected" : ""}`}
                  style={{ paddingLeft: `${8 + depth * 14}px` }}
                  data-testid="shared-event"
                  data-event-type={event.eventType}
                  data-event-name={event.name}
                >
                  <span className="mono w-8 shrink-0 text-right text-fg-faint">
                    {event.sequence}
                  </span>
                  <Badge tone={eventTone(event.eventType, event.severity)}>{event.eventType}</Badge>
                  <span className="truncate">{event.name}</span>
                </button>
              </li>
            ))}
          </ol>
        </Panel>
        <Panel
          title={selected ? `${selected.eventType} · #${selected.sequence}` : "Event"}
          className="border-0"
        >
          {selected ? (
            <div className="space-y-3 p-3" data-testid="shared-event-detail">
              <dl>
                <KeyValue label="Name">{selected.name}</KeyValue>
                <KeyValue label="Time">{dateTime(selected.timestamp)}</KeyValue>
                {selected.durationMs !== null && (
                  <KeyValue label="Duration">{duration(selected.durationMs)}</KeyValue>
                )}
                {selected.tokenUsage && (
                  <KeyValue label="Tokens">{selected.tokenUsage.totalTokens}</KeyValue>
                )}
              </dl>
              {selected.input !== undefined && <JsonView label="Input" value={selected.input} />}
              {selected.output !== undefined && <JsonView label="Output" value={selected.output} />}
              {Object.keys(selected.metadata).length > 0 && (
                <JsonView label="Metadata" value={selected.metadata} defaultExpandDepth={0} />
              )}
            </div>
          ) : (
            <EmptyState title="No events">This branch has no events.</EmptyState>
          )}
        </Panel>
      </div>
    </div>
  );
}
