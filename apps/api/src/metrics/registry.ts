/**
 * Minimal Prometheus text-exposition registry (no dependency). Counters and
 * histograms are keyed by label values; rendering is deterministic (sorted).
 */

type Labels = Record<string, string>;

function labelKey(names: readonly string[], labels: Labels): string {
  return names.map((n) => labels[n] ?? "").join("\u0000");
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function formatLabels(names: readonly string[], values: readonly string[], extra?: string): string {
  const parts = names.map((n, i) => `${n}="${escapeLabel(values[i] ?? "")}"`);
  if (extra) parts.push(extra);
  return parts.length > 0 ? `{${parts.join(",")}}` : "";
}

function formatNumber(value: number): string {
  if (value === Number.POSITIVE_INFINITY) return "+Inf";
  return Number.isInteger(value) ? String(value) : String(value);
}

export class Counter {
  private readonly values = new Map<string, { labels: string[]; value: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: readonly string[] = [],
  ) {}

  inc(labels: Labels = {}, by = 1): void {
    const key = labelKey(this.labelNames, labels);
    const entry = this.values.get(key) ?? {
      labels: this.labelNames.map((n) => labels[n] ?? ""),
      value: 0,
    };
    entry.value += by;
    this.values.set(key, entry);
  }

  get(labels: Labels = {}): number {
    return this.values.get(labelKey(this.labelNames, labels))?.value ?? 0;
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const key of [...this.values.keys()].sort()) {
      const entry = this.values.get(key) as { labels: string[]; value: number };
      lines.push(
        `${this.name}${formatLabels(this.labelNames, entry.labels)} ${formatNumber(entry.value)}`,
      );
    }
    return lines;
  }
}

export class Histogram {
  private readonly series = new Map<
    string,
    { labels: string[]; buckets: number[]; sum: number; count: number }
  >();
  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: readonly string[] = [],
    readonly bounds: readonly number[] = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
  ) {}

  observe(labels: Labels, value: number): void {
    const key = labelKey(this.labelNames, labels);
    const entry = this.series.get(key) ?? {
      labels: this.labelNames.map((n) => labels[n] ?? ""),
      buckets: this.bounds.map(() => 0),
      sum: 0,
      count: 0,
    };
    this.bounds.forEach((bound, i) => {
      if (value <= bound) (entry.buckets[i] as number)++;
    });
    entry.sum += value;
    entry.count += 1;
    this.series.set(key, entry);
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const key of [...this.series.keys()].sort()) {
      const entry = this.series.get(key) as {
        labels: string[];
        buckets: number[];
        sum: number;
        count: number;
      };
      this.bounds.forEach((bound, i) => {
        lines.push(
          `${this.name}_bucket${formatLabels(this.labelNames, entry.labels, `le="${formatNumber(bound)}"`)} ${entry.buckets[i]}`,
        );
      });
      lines.push(
        `${this.name}_bucket${formatLabels(this.labelNames, entry.labels, 'le="+Inf"')} ${entry.count}`,
      );
      lines.push(`${this.name}_sum${formatLabels(this.labelNames, entry.labels)} ${entry.sum}`);
      lines.push(`${this.name}_count${formatLabels(this.labelNames, entry.labels)} ${entry.count}`);
    }
    return lines;
  }
}

export interface GaugeSample {
  name: string;
  help: string;
  value: number;
  labels?: Labels;
}

/** Everything Shadow measures; rendered by `GET /metrics`. */
export class ShadowMetrics {
  readonly httpRequests = new Counter("shadow_http_requests_total", "HTTP requests handled.", [
    "method",
    "route",
    "status",
  ]);
  readonly httpDuration = new Histogram(
    "shadow_http_request_duration_ms",
    "HTTP request duration in milliseconds.",
    ["method", "route"],
  );
  readonly tracesCreated = new Counter("shadow_traces_created_total", "Traces created.", [
    "source",
  ]);
  readonly eventsIngested = new Counter("shadow_events_ingested_total", "Events stored.", [
    "source",
  ]);
  readonly forks = new Counter("shadow_forks_total", "Forks created.");
  readonly replays = new Counter("shadow_replays_total", "Replays executed, by final status.", [
    "status",
  ]);
  readonly comparisons = new Counter("shadow_comparisons_total", "Comparisons computed.", ["kind"]);
  readonly otlpRequests = new Counter(
    "shadow_otlp_requests_total",
    "OTLP export requests accepted.",
  );
  readonly otlpExports = new Counter(
    "shadow_otlp_exports_total",
    "Finished traces forwarded to the OTLP collector, by result.",
    ["result"],
  );
  readonly pruned = new Counter(
    "shadow_traces_pruned_total",
    "Traces deleted by prune or retention.",
  );
  private readonly startedAt = Date.now();

  /** Text exposition (Prometheus 0.0.4). `gauges` are sampled by the caller at scrape time. */
  render(gauges: readonly GaugeSample[] = []): string {
    const lines: string[] = [];
    for (const metric of [
      this.httpRequests,
      this.httpDuration,
      this.tracesCreated,
      this.eventsIngested,
      this.forks,
      this.replays,
      this.comparisons,
      this.otlpRequests,
      this.otlpExports,
      this.pruned,
    ]) {
      lines.push(...metric.render());
    }
    const memory = process.memoryUsage();
    const process_: GaugeSample[] = [
      {
        name: "process_uptime_seconds",
        help: "Seconds since the API started.",
        value: Math.round((Date.now() - this.startedAt) / 1000),
      },
      {
        name: "process_resident_memory_bytes",
        help: "Resident set size in bytes.",
        value: memory.rss,
      },
      {
        name: "nodejs_heap_used_bytes",
        help: "V8 heap used in bytes.",
        value: memory.heapUsed,
      },
    ];
    for (const gauge of [...process_, ...gauges]) {
      lines.push(`# HELP ${gauge.name} ${gauge.help}`, `# TYPE ${gauge.name} gauge`);
      const names = Object.keys(gauge.labels ?? {});
      lines.push(
        `${gauge.name}${formatLabels(
          names,
          names.map((n) => gauge.labels?.[n] ?? ""),
        )} ${formatNumber(gauge.value)}`,
      );
    }
    return `${lines.join("\n")}\n`;
  }
}
