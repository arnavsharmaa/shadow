import { compact, duration, money } from "./format";

export interface TrendPoint {
  start: string;
  traces: number;
  completed: number;
  failed: number;
  policyViolations: number;
  avgDurationMs: number | null;
  p95DurationMs: number | null;
  totalEstimatedCost: number;
  totalTokens: number;
}

export type TrendMetric =
  "traces" | "failed" | "policyViolations" | "p95DurationMs" | "totalEstimatedCost" | "totalTokens";

export const TREND_METRICS: { key: TrendMetric; label: string }[] = [
  { key: "traces", label: "Traces" },
  { key: "failed", label: "Failed traces" },
  { key: "policyViolations", label: "Policy violations" },
  { key: "p95DurationMs", label: "p95 duration" },
  { key: "totalEstimatedCost", label: "Estimated cost" },
  { key: "totalTokens", label: "Tokens" },
];

/** The value a point plots for a metric; buckets without traces have no latency. */
export function metricValue(point: TrendPoint, metric: TrendMetric): number | null {
  return point[metric];
}

export function formatMetric(value: number | null, metric: TrendMetric): string {
  if (value === null) return "–";
  if (metric === "p95DurationMs") return duration(value);
  if (metric === "totalEstimatedCost") return money(value);
  if (metric === "totalTokens") return compact(value);
  return value.toLocaleString("en-US");
}

/**
 * Clean axis ticks from zero: 1, 2 or 5 times a power of ten, about `count` steps, covering
 * `max`. Integer metrics never get fractional ticks.
 */
export function niceTicks(max: number, count = 4, integer = false): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const unit = [1, 2, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? 10 * power;
  const step = integer ? Math.max(1, Math.ceil(unit)) : unit;
  const ticks: number[] = [];
  for (let v = 0; v < max + step * 1e-9; v += step) ticks.push(Number(v.toPrecision(12)));
  if ((ticks[ticks.length - 1] ?? 0) < max)
    ticks.push(Number((ticks.length * step).toPrecision(12)));
  return ticks;
}

/** Short bucket label: `Sep 1` for days, `Sep 1 09:00` for hours (UTC). */
export function bucketLabel(start: string, bucket: "day" | "hour"): string {
  const date = new Date(start);
  const day = date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  if (bucket === "day") return day;
  return `${day} ${String(date.getUTCHours()).padStart(2, "0")}:00`;
}
