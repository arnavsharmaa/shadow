"use client";

import {
  bucketLabel,
  formatMetric,
  metricValue,
  niceTicks,
  type TrendMetric,
  type TrendPoint,
} from "@/lib/trend";
import { useState } from "react";

const WIDTH = 720;
const PAD = { top: 18, right: 12, bottom: 24, left: 56 };
const BAR_MAX = 24;
const GAP = 2;

/** Rounded 4px data-end, square at the baseline (dataviz mark spec). */
function barPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}

export interface ColumnChartProps {
  points: TrendPoint[];
  metric: TrendMetric;
  bucket: "day" | "hour";
  /** Series name for the tooltip, axis and accessible label. */
  label: string;
  /** What the series is about, for the accessible label (for example an agent slug). */
  subject?: string;
  height?: number;
  /** Prefix for `data-testid` attributes (default `trend`). */
  testId?: string;
}

/**
 * A single-series column chart with a hairline grid, clean ticks, the maximum labelled, a
 * tooltip beside the hovered bar and a table view. One axis, one colour: the mark colour is
 * the `--chart-1` token, validated against both panel surfaces.
 */
export function ColumnChart({
  points,
  metric,
  bucket,
  label,
  subject,
  height = 200,
  testId = "trend",
}: ColumnChartProps) {
  const [hover, setHover] = useState<number | null>(null);
  const values = points.map((p) => metricValue(p, metric));
  const max = Math.max(0, ...values.map((v) => v ?? 0));
  const integer = metric === "traces" || metric === "failed" || metric === "policyViolations";
  const ticks = niceTicks(max, 4, integer);
  const top = ticks[ticks.length - 1] ?? 1;
  const plotW = WIDTH - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom;
  const band = points.length > 0 ? plotW / points.length : plotW;
  const barW = Math.max(1, Math.min(BAR_MAX, band - GAP));
  const y = (v: number) => PAD.top + plotH - (v / top) * plotH;
  const maxIndex = values.findIndex((v) => v !== null && v === max && max > 0);
  const labelEvery = Math.max(1, Math.ceil(points.length / 6));
  const hovered = hover !== null ? points[hover] : undefined;

  return (
    <div>
      {/* The tooltip is positioned in the chart's own box, so both share one width. */}
      <div className="relative max-w-[900px]">
        <svg
          viewBox={`0 0 ${WIDTH} ${height}`}
          className="h-auto w-full"
          role="img"
          aria-label={`${label} per ${bucket}${subject ? ` for ${subject}` : ""}; maximum ${formatMetric(max, metric)}`}
          data-testid={`${testId}-chart`}
          onMouseLeave={() => setHover(null)}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={PAD.left}
                x2={WIDTH - PAD.right}
                y1={y(t)}
                y2={y(t)}
                stroke="var(--border)"
                strokeWidth={1}
              />
              <text
                x={PAD.left - 6}
                y={y(t)}
                textAnchor="end"
                dominantBaseline="middle"
                fontSize={10}
                fill="var(--fg-muted)"
              >
                {t === 0 ? "0" : formatMetric(t, metric)}
              </text>
            </g>
          ))}
          {points.map((p, i) => {
            const v = values[i] ?? null;
            const x = PAD.left + i * band + (band - barW) / 2;
            return (
              <g key={p.start}>
                {v !== null && v > 0 && (
                  <path
                    d={barPath(x, y(v), barW, PAD.top + plotH - y(v))}
                    fill="var(--chart-1)"
                    opacity={hover === null || hover === i ? 1 : 0.55}
                  />
                )}
                {i === maxIndex && (
                  <text
                    x={x + barW / 2}
                    y={y(max) - 5}
                    textAnchor="middle"
                    fontSize={10}
                    fill="var(--fg)"
                    data-testid={`${testId}-max-label`}
                  >
                    {formatMetric(max, metric)}
                  </text>
                )}
                {i % labelEvery === 0 && (
                  <text
                    x={PAD.left + i * band + band / 2}
                    y={height - 8}
                    textAnchor="middle"
                    fontSize={10}
                    fill="var(--fg-muted)"
                  >
                    {bucketLabel(p.start, bucket)}
                  </text>
                )}
                {/* The whole band is the hit target, taller and wider than the bar. */}
                <rect
                  x={PAD.left + i * band}
                  y={PAD.top}
                  width={band}
                  height={plotH}
                  fill="transparent"
                  onMouseEnter={() => setHover(i)}
                  data-testid={`${testId}-bar`}
                />
              </g>
            );
          })}
        </svg>
        {hovered && hover !== null && (
          <div
            className="pointer-events-none absolute top-[30%] whitespace-nowrap rounded border border-border bg-panel px-2 py-1 text-[11px] shadow"
            // Beside the hovered band (left of it in the right half) so it never hides the bar.
            style={
              hover >= points.length / 2
                ? { right: `${(1 - (PAD.left + hover * band - 4) / WIDTH) * 100}%` }
                : { left: `${((PAD.left + (hover + 1) * band + 4) / WIDTH) * 100}%` }
            }
            role="status"
            data-testid={`${testId}-tooltip`}
          >
            <div className="text-fg-muted">{bucketLabel(hovered.start, bucket)}</div>
            <div className="font-semibold">
              {label}: {formatMetric(metricValue(hovered, metric), metric)}
            </div>
            <div className="text-fg-muted">
              {hovered.traces} trace{hovered.traces === 1 ? "" : "s"}, {hovered.failed} failed
            </div>
          </div>
        )}
      </div>
      <details className="mt-2">
        <summary className="cursor-pointer text-[11px] text-fg-muted">Show as a table</summary>
        <table className="mt-1 border-collapse" data-testid={`${testId}-table`}>
          <thead className="text-left text-[11px] text-fg-muted">
            <tr>
              <th className="py-0.5 pr-4">{bucket === "day" ? "Day" : "Hour"} (UTC)</th>
              <th className="py-0.5 pr-4 text-right">{label}</th>
              <th className="py-0.5 text-right">Traces</th>
            </tr>
          </thead>
          <tbody className="tabular">
            {points
              .filter((p) => p.traces > 0)
              .map((p) => (
                <tr key={p.start} className="border-t border-border">
                  <td className="py-0.5 pr-4">{bucketLabel(p.start, bucket)}</td>
                  <td className="py-0.5 pr-4 text-right">
                    {formatMetric(metricValue(p, metric), metric)}
                  </td>
                  <td className="py-0.5 text-right">{p.traces}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
