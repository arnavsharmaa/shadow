"use client";

import { api } from "@/lib/api";
import { classNames } from "@/lib/format";
import { isErrorEvent, isPolicyViolationEvent } from "@shadow/core";
import type { Branch, ShadowEvent } from "@shadow/schemas";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, ErrorState, Kbd, Panel, Skeleton } from "../ui/primitives";
import { BranchGraph } from "./BranchGraph";
import { EventDetail } from "./EventDetail";
import { EventTree } from "./EventTree";
import { ForkDialog } from "./ForkDialog";
import { StateInspector } from "./StateInspector";
import { Timeline } from "./Timeline";
import { TraceHeader } from "./TraceHeader";

const FORKABLE_PREFIXES = ["tool.", "model.", "policy.", "context.", "state.", "human.", "agent."];

export function isForkable(event: ShadowEvent): boolean {
  if (event.eventType === "fork.created" || event.eventType.startsWith("replay.")) return false;
  if (
    event.eventType === "trace.started" ||
    event.eventType === "trace.completed" ||
    event.eventType === "trace.failed"
  )
    return false;
  const shadow = event.metadata.shadow as { origin?: string } | undefined;
  if (shadow?.origin === "override") return false;
  return FORKABLE_PREFIXES.some((p) => event.eventType.startsWith(p));
}

export function TraceDetail({ traceId }: { traceId: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const queryClient = useQueryClient();

  const detail = useQuery({ queryKey: ["trace", traceId], queryFn: () => api.trace(traceId) });
  const branches = detail.data?.branches ?? [];
  const branchId = params.get("branch") ?? detail.data?.trace.rootBranchId ?? null;
  const branch = branches.find((b) => b.id === branchId) ?? null;

  const tree = useQuery({
    queryKey: ["tree", traceId, branchId],
    queryFn: () => api.tree(traceId, branchId ?? undefined),
    enabled: branchId !== null,
  });
  const events = useMemo(() => tree.data?.events ?? [], [tree.data]);
  const eventsById = useMemo(() => new Map(events.map((e) => [e.id, e])), [events]);

  const selectedId = params.get("event");
  const selected = selectedId ? (eventsById.get(selectedId) ?? null) : null;

  const navigate = useCallback(
    (patch: { branch?: string | null; event?: string | null }) => {
      const next = new URLSearchParams(params.toString());
      if (patch.branch !== undefined) {
        if (patch.branch === null) next.delete("branch");
        else next.set("branch", patch.branch);
      }
      if (patch.event !== undefined) {
        if (patch.event === null) next.delete("event");
        else next.set("event", patch.event);
      }
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [params, pathname, router],
  );

  const selectEvent = useCallback((id: string | null) => navigate({ event: id }), [navigate]);
  const selectBranch = useCallback(
    (id: string) => navigate({ branch: id, event: null }),
    [navigate],
  );

  // Default selection: the first error/policy violation if any, else the first tool call.
  useEffect(() => {
    if (selectedId || events.length === 0) return;
    const first =
      events.find(isErrorEvent) ??
      events.find(isPolicyViolationEvent) ??
      events.find((e) => e.eventType === "tool.request") ??
      events[0];
    if (first) selectEvent(first.id);
  }, [events, selectedId, selectEvent]);

  const [forkOpen, setForkOpen] = useState(false);
  const [leftTab, setLeftTab] = useState<"events" | "branches">("events");
  const [bottomOpen, setBottomOpen] = useState(true);

  const selectedIndex = selected ? events.findIndex((e) => e.id === selected.id) : -1;
  const moveSelection = useCallback(
    (delta: number) => {
      if (events.length === 0) return;
      const next = Math.min(
        events.length - 1,
        Math.max(0, (selectedIndex === -1 ? 0 : selectedIndex) + delta),
      );
      const event = events[next];
      if (event) selectEvent(event.id);
    },
    [events, selectedIndex, selectEvent],
  );

  const jumpTo = useCallback(
    (predicate: (e: ShadowEvent) => boolean) => {
      const found = events.find(predicate);
      if (found) selectEvent(found.id);
    },
    [events, selectEvent],
  );

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      )
        return;
      if (forkOpen) return;
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        moveSelection(1);
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        moveSelection(-1);
      } else if (e.key === "f" && selected && isForkable(selected)) {
        setForkOpen(true);
      } else if (e.key === "e") {
        jumpTo(isErrorEvent);
      } else if (e.key === "p") {
        jumpTo(isPolicyViolationEvent);
      } else if (e.key === "b") {
        setLeftTab((t) => (t === "events" ? "branches" : "events"));
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [moveSelection, jumpTo, selected, forkOpen]);

  const refreshBranches = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ["trace", traceId] });
  }, [queryClient, traceId]);

  const updateTags = useCallback(
    async (change: { addTags?: string[]; removeTags?: string[] }) => {
      await api.updateTrace(traceId, change);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["trace", traceId] }),
        queryClient.invalidateQueries({ queryKey: ["traces"] }),
        queryClient.invalidateQueries({ queryKey: ["facets"] }),
      ]);
    },
    [queryClient, traceId],
  );

  if (detail.isError) return <ErrorState error={detail.error} retry={() => detail.refetch()} />;
  if (!detail.data || !branchId) {
    return (
      <div className="space-y-2 p-3" aria-busy="true" aria-label="Loading trace">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-[60vh] w-full" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col" data-testid="trace-detail">
      <TraceHeader
        trace={detail.data.trace}
        branches={branches}
        branch={branch}
        onSelectBranch={selectBranch}
        onOpenBranches={() => setLeftTab("branches")}
        onJumpError={() => jumpTo(isErrorEvent)}
        onJumpPolicy={() => jumpTo(isPolicyViolationEvent)}
        hasError={events.some(isErrorEvent)}
        hasPolicy={events.some(isPolicyViolationEvent)}
        onUpdateTags={updateTags}
      />
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(280px,22%)_minmax(360px,1fr)_minmax(300px,28%)] gap-px bg-border">
        <Panel
          title={
            <span className="flex items-center gap-2">
              <TabButton
                active={leftTab === "events"}
                onClick={() => setLeftTab("events")}
                testId="tab-events"
              >
                Execution
              </TabButton>
              <TabButton
                active={leftTab === "branches"}
                onClick={() => setLeftTab("branches")}
                testId="tab-branches"
              >
                Branches ({branches.length})
              </TabButton>
            </span>
          }
          actions={
            leftTab === "events" ? (
              <span className="text-[10px] text-fg-faint">{events.length} events</span>
            ) : undefined
          }
          className="border-0"
        >
          {leftTab === "events" ? (
            tree.isError ? (
              <ErrorState error={tree.error} retry={() => tree.refetch()} />
            ) : tree.isLoading ? (
              <div className="space-y-1 p-2" aria-busy="true">
                {Array.from({ length: 12 }).map((_, i) => (
                  <Skeleton key={i} className="h-5 w-full" />
                ))}
              </div>
            ) : (
              <EventTree
                events={events}
                nodes={tree.data?.nodes ?? []}
                selectedId={selected?.id ?? null}
                onSelect={selectEvent}
                forkSequence={branch?.forkSequence ?? null}
              />
            )
          ) : (
            <BranchGraph
              trace={detail.data.trace}
              branches={branches}
              events={events}
              currentBranchId={branchId}
              onSelectBranch={selectBranch}
              onChanged={refreshBranches}
            />
          )}
        </Panel>
        <Panel
          title={selected ? `${selected.eventType} · #${selected.sequence}` : "Event"}
          className="border-0"
          actions={
            selected && isForkable(selected) ? (
              <Button
                variant="primary"
                size="xs"
                onClick={() => setForkOpen(true)}
                data-testid="fork-from-here"
              >
                Fork from here <Kbd>f</Kbd>
              </Button>
            ) : undefined
          }
        >
          {selected ? (
            <EventDetail
              event={selected}
              events={events}
              eventsById={eventsById}
              onSelect={selectEvent}
            />
          ) : (
            <div className="p-4 text-[12px] text-fg-muted">
              Select an event to inspect it. Use <Kbd>j</Kbd>/<Kbd>k</Kbd> to move.
            </div>
          )}
        </Panel>
        <Panel title="State inspector" className="border-0">
          <StateInspector traceId={traceId} branchId={branchId} event={selected} />
        </Panel>
      </div>
      <div
        className={classNames(
          "shrink-0 border-t border-border bg-panel",
          bottomOpen ? "h-56" : "h-8",
        )}
      >
        <div className="flex h-8 items-center justify-between px-2.5 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
          <span>Timeline</span>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setBottomOpen((o) => !o)}
            aria-expanded={bottomOpen}
          >
            {bottomOpen ? "Collapse" : "Expand"}
          </Button>
        </div>
        {bottomOpen && (
          <Timeline
            events={events}
            selectedId={selected?.id ?? null}
            onSelect={selectEvent}
            forkSequence={branch?.forkSequence ?? null}
          />
        )}
      </div>
      {selected && branch && (
        <ForkDialog
          key={forkOpen ? `${branch.id}:${selected.id}` : "closed"}
          open={forkOpen}
          onClose={() => setForkOpen(false)}
          traceId={traceId}
          branch={branch}
          branches={branches}
          event={selected}
          onCreated={async (created: Branch, comparisonId: string | null) => {
            setForkOpen(false);
            await refreshBranches();
            if (comparisonId) {
              router.push(
                `/traces/${encodeURIComponent(traceId)}/compare?comparison=${encodeURIComponent(comparisonId)}`,
              );
            } else {
              selectBranch(created.id);
            }
          }}
        />
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
  testId,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      aria-pressed={active}
      className={classNames(
        "rounded px-1.5 py-0.5 normal-case tracking-normal",
        active ? "bg-muted text-fg" : "text-fg-muted hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}
