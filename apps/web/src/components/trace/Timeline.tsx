"use client";

import { classNames, duration, timeOfDay } from "@/lib/format";
import type { ShadowEvent } from "@shadow/schemas";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../ui/primitives";

interface Props {
  events: ShadowEvent[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  forkSequence: number | null;
}

type Lane = "model" | "tool" | "policy" | "state" | "human" | "lifecycle";
const LANES: { key: Lane; label: string; color: string }[] = [
  { key: "lifecycle", label: "lifecycle", color: "var(--fg-faint)" },
  { key: "model", label: "model", color: "var(--purple)" },
  { key: "tool", label: "tools", color: "var(--teal)" },
  { key: "policy", label: "policy", color: "var(--warn)" },
  { key: "human", label: "human", color: "var(--warn)" },
  { key: "state", label: "state", color: "var(--fg-muted)" },
];

function laneOf(event: ShadowEvent): Lane {
  if (event.eventType.startsWith("model.")) return "model";
  if (event.eventType.startsWith("tool.")) return "tool";
  if (event.eventType.startsWith("policy.")) return "policy";
  if (event.eventType.startsWith("human.")) return "human";
  if (event.eventType.startsWith("state.") || event.eventType.startsWith("context."))
    return "state";
  return "lifecycle";
}

interface Item {
  event: ShadowEvent;
  lane: Lane;
  start: number;
  end: number;
  isSpan: boolean;
  error: boolean;
  violation: boolean;
}

const LANE_HEIGHT = 22;
const LEFT = 64;

/** Temporal view: spans as bars, instantaneous events as ticks; zoom with buttons or ctrl+wheel. */
export function Timeline({ events, selectedId, onSelect, forkSequence }: Props) {
  const [zoom, setZoom] = useState(1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    setWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);

  const { items, t0, t1 } = useMemo(() => {
    const byId = new Map(events.map((e) => [e.id, e]));
    const closers = new Map<string, ShadowEvent>();
    for (const e of events) {
      if (
        e.parentEventId &&
        e.durationMs != null &&
        (e.eventType.endsWith(".response") || e.eventType === "tool.error")
      )
        closers.set(e.parentEventId, e);
    }
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    const list: Item[] = [];
    for (const e of events) {
      const ts = Date.parse(e.timestamp);
      if (Number.isNaN(ts)) continue;
      const closer = closers.get(e.id);
      let start = ts;
      let end = ts;
      let isSpan = false;
      if (closer) {
        end = Date.parse(closer.timestamp);
        isSpan = end > start;
      } else if (
        e.durationMs != null &&
        e.durationMs > 0 &&
        (e.eventType === "agent.completed" || e.eventType === "replay.completed")
      ) {
        start = ts - e.durationMs;
        isSpan = true;
      }
      if (
        e.parentEventId &&
        byId.get(e.parentEventId) &&
        e.durationMs != null &&
        e.eventType !== "policy.evaluated"
      )
        continue; // closers drawn as part of their opener
      min = Math.min(min, start);
      max = Math.max(max, end);
      list.push({
        event: e,
        lane: laneOf(e),
        start,
        end,
        isSpan,
        error: e.severity === "error" || e.eventType === "tool.error",
        violation: e.eventType === "policy.denied" || e.eventType === "policy.approval_required",
      });
    }
    if (!Number.isFinite(min)) return { items: [], t0: 0, t1: 1 };
    return { items: list, t0: min, t1: Math.max(max, min + 1) };
  }, [events]);

  const total = t1 - t0;
  const innerWidth = Math.max(width - LEFT - 16, 200) * zoom;
  const x = (t: number) => LEFT + ((t - t0) / total) * innerWidth;
  const height = LANES.length * LANE_HEIGHT + 24;

  useEffect(() => {
    if (!selectedId || !scrollRef.current) return;
    const item = items.find((i) => i.event.id === selectedId);
    if (!item) return;
    const px = x(item.start);
    const el = scrollRef.current;
    if (px < el.scrollLeft + LEFT || px > el.scrollLeft + el.clientWidth - 40)
      el.scrollTo({ left: Math.max(0, px - el.clientWidth / 2) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, zoom]);

  const ticks = useMemo(() => {
    const count = Math.max(4, Math.min(24, Math.round(6 * zoom)));
    return Array.from({ length: count + 1 }, (_, i) => t0 + (total * i) / count);
  }, [t0, total, zoom]);

  if (items.length === 0)
    return <p className="p-3 text-[12px] text-fg-muted">No events to plot.</p>;

  const forkX =
    forkSequence !== null ? items.find((i) => i.event.sequence > forkSequence) : undefined;

  return (
    <div className="flex h-[calc(100%-2rem)] flex-col" data-testid="timeline">
      <div className="flex items-center gap-2 px-2 pb-1 text-[11px] text-fg-muted">
        <span>{duration(total)} total</span>
        <span className="ml-auto flex items-center gap-1">
          <Button
            size="xs"
            variant="ghost"
            onClick={() => setZoom((z) => Math.max(1, z / 1.5))}
            aria-label="Zoom out"
            disabled={zoom <= 1}
          >
            −
          </Button>
          <span className="tabular w-10 text-center">{zoom.toFixed(1)}×</span>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => setZoom((z) => Math.min(32, z * 1.5))}
            aria-label="Zoom in"
          >
            +
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setZoom(1)} disabled={zoom === 1}>
            Reset
          </Button>
        </span>
      </div>
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden"
        onWheel={(e) => {
          if (!e.ctrlKey && !e.metaKey) return;
          e.preventDefault();
          setZoom((z) => Math.min(32, Math.max(1, z * (e.deltaY < 0 ? 1.2 : 1 / 1.2))));
        }}
      >
        <svg
          width={LEFT + innerWidth + 16}
          height={height}
          role="img"
          aria-label="Timeline of events"
          className="block select-none"
        >
          {LANES.map((lane, i) => (
            <g key={lane.key}>
              <rect
                x={0}
                y={i * LANE_HEIGHT}
                width={LEFT + innerWidth + 16}
                height={LANE_HEIGHT}
                fill={i % 2 === 0 ? "var(--bg)" : "transparent"}
              />
              <text
                x={6}
                y={i * LANE_HEIGHT + 14}
                fontSize={10}
                fill="var(--fg-muted)"
                fontFamily="var(--font-mono)"
              >
                {lane.label}
              </text>
            </g>
          ))}
          {ticks.map((t, i) => (
            <g key={i}>
              <line
                x1={x(t)}
                x2={x(t)}
                y1={0}
                y2={LANES.length * LANE_HEIGHT}
                stroke="var(--border)"
                strokeDasharray="2 3"
              />
              <text
                x={x(t) + 2}
                y={height - 6}
                fontSize={9}
                fill="var(--fg-faint)"
                fontFamily="var(--font-mono)"
              >
                +{duration(t - t0)} {i === 0 && `(${timeOfDay(new Date(t0).toISOString())})`}
              </text>
            </g>
          ))}
          {forkX && (
            <g>
              <line
                x1={x(forkX.start)}
                x2={x(forkX.start)}
                y1={0}
                y2={LANES.length * LANE_HEIGHT}
                stroke="var(--info)"
                strokeWidth={1.5}
              />
              <text x={x(forkX.start) + 3} y={10} fontSize={9} fill="var(--info)">
                fork
              </text>
            </g>
          )}
          {items.map((item) => {
            const laneIndex = LANES.findIndex((l) => l.key === item.lane);
            const y = laneIndex * LANE_HEIGHT + 4;
            const color = item.error
              ? "var(--err)"
              : item.violation
                ? "var(--warn)"
                : (LANES[laneIndex]?.color ?? "var(--fg)");
            const selected = item.event.id === selectedId;
            const x1 = x(item.start);
            const w = Math.max(item.isSpan ? x(item.end) - x1 : 2, 2);
            const title = `#${item.event.sequence} ${item.event.eventType} ${item.event.name}${item.isSpan ? ` (${duration(item.end - item.start)})` : ""}`;
            return (
              <g
                key={item.event.id}
                onClick={() => onSelect(item.event.id)}
                className="cursor-pointer"
                data-testid="timeline-item"
                data-event-id={item.event.id}
              >
                <title>{title}</title>
                <rect
                  x={x1}
                  y={y}
                  width={w}
                  height={LANE_HEIGHT - 8}
                  rx={2}
                  fill={color}
                  fillOpacity={item.isSpan ? 0.7 : 1}
                  stroke={selected ? "var(--fg)" : "none"}
                  strokeWidth={selected ? 1.5 : 0}
                  className={classNames(selected && "drop-shadow")}
                />
                {item.isSpan && w > 40 && (
                  <text
                    x={x1 + 3}
                    y={y + 10}
                    fontSize={9}
                    fill="var(--accent-fg)"
                    fontFamily="var(--font-mono)"
                    pointerEvents="none"
                  >
                    {item.event.name.slice(0, Math.floor(w / 6))}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
