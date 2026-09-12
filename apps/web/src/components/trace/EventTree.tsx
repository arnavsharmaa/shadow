"use client";

import type { TreeNode } from "@/lib/api";
import { classNames, duration, money } from "@/lib/format";
import type { ShadowEvent } from "@shadow/schemas";
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, eventTone } from "../ui/primitives";

interface Props {
  events: ShadowEvent[];
  nodes: TreeNode[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  forkSequence: number | null;
}

const ROW_HEIGHT = 24;
const OVERSCAN = 20;
/** Above this many visible rows only the rows near the viewport are rendered. */
const VIRTUALIZE_FROM = 500;

/** Depth-first execution hierarchy with collapsible spans; windowed for large traces. */
export function EventTree({ events, nodes, selectedId, onSelect, forkSequence }: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [showState, setShowState] = useState(true);
  const [filter, setFilter] = useState("");
  const byId = useMemo(() => new Map(events.map((e) => [e.id, e])), [events]);
  const listRef = useRef<HTMLUListElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 800 });

  const needle = filter.trim().toLowerCase();
  const rows = useMemo(() => {
    const out: { node: TreeNode; event: ShadowEvent; hidden: boolean }[] = [];
    const hiddenDepth: number[] = [];
    if (needle) {
      // A filtered view is a flat list of matches: collapsing and hierarchy do not apply.
      for (const node of nodes) {
        const event = byId.get(node.id);
        if (!event) continue;
        if (
          event.name.toLowerCase().includes(needle) ||
          event.eventType.toLowerCase().includes(needle)
        )
          out.push({ node: { ...node, depth: 0, childCount: 0 }, event, hidden: false });
      }
      return out;
    }
    for (const node of nodes) {
      const event = byId.get(node.id);
      if (!event) continue;
      while (
        hiddenDepth.length > 0 &&
        node.depth <= (hiddenDepth[hiddenDepth.length - 1] as number)
      )
        hiddenDepth.pop();
      const hidden = hiddenDepth.length > 0;
      if (collapsed.has(node.id)) hiddenDepth.push(node.depth);
      if (
        !showState &&
        (event.eventType.startsWith("state.") || event.eventType.startsWith("context."))
      )
        continue;
      out.push({ node, event, hidden });
    }
    return out.filter((r) => !r.hidden);
  }, [nodes, byId, collapsed, showState, needle]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const measure = () =>
      setViewport((v) => (v.height === el.clientHeight ? v : { ...v, height: el.clientHeight }));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const virtual = rows.length > VIRTUALIZE_FROM;
  const start = virtual ? Math.max(0, Math.floor(viewport.top / ROW_HEIGHT) - OVERSCAN) : 0;
  const end = virtual
    ? Math.min(rows.length, Math.ceil((viewport.top + viewport.height) / ROW_HEIGHT) + OVERSCAN)
    : rows.length;
  const visibleRows = rows.slice(start, end);

  useEffect(() => {
    const el = listRef.current;
    if (!selectedId || !el) return;
    const index = rows.findIndex((r) => r.event.id === selectedId);
    if (index === -1) return;
    const top = index * ROW_HEIGHT;
    if (top < el.scrollTop || top + ROW_HEIGHT > el.scrollTop + el.clientHeight) {
      el.scrollTop = Math.max(0, top - el.clientHeight / 2);
    }
  }, [selectedId, rows]);

  const toggle = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-2 py-1 text-[11px] text-fg-muted">
        <input
          type="search"
          aria-label="Filter events"
          placeholder="filter by name or type"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="h-5 w-36 rounded border border-border bg-bg px-1 text-[11px] text-fg placeholder:text-fg-faint focus:outline-none"
          data-testid="event-filter"
        />
        {needle && (
          <span className="text-fg-faint" data-testid="event-filter-count">
            {rows.length} match{rows.length === 1 ? "" : "es"}
          </span>
        )}
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={showState}
            onChange={(e) => setShowState(e.target.checked)}
          />{" "}
          state &amp; context
        </label>
        <button
          type="button"
          className="ml-auto hover:text-fg"
          onClick={() => setCollapsed(new Set())}
        >
          Expand all
        </button>
        <button
          type="button"
          className="hover:text-fg"
          onClick={() =>
            setCollapsed(
              new Set(nodes.filter((n) => n.childCount > 0 && n.depth > 0).map((n) => n.id)),
            )
          }
        >
          Collapse spans
        </button>
      </div>
      <ul
        ref={listRef}
        className="min-h-0 flex-1 overflow-auto py-1"
        role="tree"
        aria-label="Execution tree"
        data-testid="event-tree"
        data-virtualized={virtual ? "true" : "false"}
        onScroll={(e) => {
          if (!virtual) return;
          const top = e.currentTarget.scrollTop;
          setViewport((v) => (Math.abs(v.top - top) < ROW_HEIGHT ? v : { ...v, top }));
        }}
      >
        {virtual && start > 0 && <li aria-hidden="true" style={{ height: start * ROW_HEIGHT }} />}
        {visibleRows.map(({ node, event }) => {
          const selected = event.id === selectedId;
          const inherited = forkSequence !== null && event.sequence <= forkSequence;
          const isSetup =
            event.eventType === "fork.created" || event.eventType.startsWith("replay.");
          const shadow = event.metadata.shadow as
            { origin?: string; overrideApplied?: boolean } | undefined;
          const isOverride = shadow?.origin === "override" || shadow?.overrideApplied === true;
          return (
            <li
              key={event.id}
              role="treeitem"
              aria-selected={selected}
              aria-level={node.depth + 1}
              data-event-id={event.id}
              data-event-type={event.eventType}
              data-event-name={event.name}
              data-testid="event-node"
            >
              <div
                className={classNames(
                  "group flex h-6 cursor-pointer items-center gap-1 pr-2 text-[12px] hover:bg-hover",
                  selected && "bg-selected",
                  inherited && "opacity-70",
                )}
                style={{ paddingLeft: `${8 + node.depth * 14}px` }}
                onClick={() => onSelect(event.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect(event.id);
                  }
                }}
                tabIndex={0}
              >
                {node.childCount > 0 ? (
                  <button
                    type="button"
                    className="w-3 shrink-0 text-center text-fg-faint hover:text-fg"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggle(event.id);
                    }}
                    aria-label={collapsed.has(event.id) ? "Expand" : "Collapse"}
                    tabIndex={-1}
                  >
                    {collapsed.has(event.id) ? "▸" : "▾"}
                  </button>
                ) : (
                  <span className="w-3 shrink-0" />
                )}
                <span className="mono w-8 shrink-0 text-right text-[10px] text-fg-faint">
                  {event.sequence}
                </span>
                <Badge tone={eventTone(event.eventType, event.severity)} className="shrink-0">
                  {shortType(event.eventType)}
                </Badge>
                <span
                  className={classNames("truncate", isSetup && "italic text-fg-muted")}
                  title={event.name}
                >
                  {event.name}
                </span>
                {isOverride && (
                  <Badge tone="info" className="shrink-0">
                    override
                  </Badge>
                )}
                <span className="ml-auto flex shrink-0 items-center gap-2 text-[10px] text-fg-faint">
                  {event.estimatedCost && (
                    <span>{money(event.estimatedCost.amount, event.estimatedCost.currency)}</span>
                  )}
                  {node.spanDurationMs !== null ? (
                    <span>{duration(node.spanDurationMs)}</span>
                  ) : event.durationMs != null ? (
                    <span>{duration(event.durationMs)}</span>
                  ) : null}
                </span>
              </div>
            </li>
          );
        })}
        {virtual && end < rows.length && (
          <li aria-hidden="true" style={{ height: (rows.length - end) * ROW_HEIGHT }} />
        )}
      </ul>
    </div>
  );
}

export function shortType(eventType: string): string {
  const [category, action] = eventType.split(".");
  if (!action) return eventType;
  const map: Record<string, string> = {
    request: "req",
    response: "res",
    evaluated: "eval",
    approval_required: "approval",
    approval_requested: "approval?",
    approval_resolved: "approval✓",
    snapshot: "snap",
    completed: "done",
    started: "start",
  };
  return `${category}.${map[action] ?? action}`;
}
