import type { JsonObject, JsonValue } from "@shadow/schemas";
import { createRedactor, type RedactOptions } from "./redact.js";
import { Trace } from "./trace.js";
import { HttpTransport, NoopTransport, type Transport } from "./transport.js";

export interface ShadowOptions {
  /** Project slug traces are recorded under (default: `SHADOW_PROJECT` env). Created on first use. */
  project?: string;
  /** Default agent slug for traces started from this client (default: `SHADOW_AGENT` env). */
  agent?: string;
  /** Shadow API base URL. Defaults to `SHADOW_ENDPOINT` or http://localhost:4000. */
  endpoint?: string;
  /** Custom transport (tests, file export, future async transports). */
  transport?: Transport;
  headers?: Record<string, string>;
  /** Bearer token for APIs started with SHADOW_API_TOKEN (default: SHADOW_TOKEN env). */
  token?: string;
  /** Milliseconds between automatic flushes. Default 1000; 0 disables the timer. */
  flushIntervalMs?: number;
  /** Flush as soon as this many events are buffered. Default 100. */
  maxBatchSize?: number;
  /** Called when the transport fails. Defaults to a single console warning. */
  onError?: (error: Error) => void;
  /** Redaction configuration; `false` disables client-side redaction. */
  redact?: RedactOptions | false;
  /** Emit a full state snapshot every N mutations (default 25; 0 disables). */
  snapshotEvery?: number;
  /**
   * Disable recording entirely (no events are produced or sent). Defaults to the
   * `SHADOW_ENABLED` env: `0`, `false`, `no` or `off` disable the SDK.
   */
  enabled?: boolean;
  /**
   * Fraction of traces to record, 0 to 1 (default 1, or `SHADOW_SAMPLE_RATE`). Traces started
   * with an explicit `id` are sampled deterministically from that id, so retries of the same
   * run make the same decision; others are sampled at random.
   */
  sampleRate?: number;
  /** Custom sampling decision; overrides `sampleRate` (except for `sample` on startTrace). */
  sampler?: (input: StartTraceOptions) => boolean;
}

export interface StartTraceOptions {
  name: string;
  agent?: string;
  id?: string;
  metadata?: JsonObject;
  tags?: string[];
  startedAt?: string;
  /** Force the sampling decision for this trace (true records, false discards). */
  sample?: boolean;
}

/** FNV-1a hash of a string mapped to [0, 1). */
function hashToUnit(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash / 0x100000000;
}

function readEnv(name: string): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  const value = env?.[name];
  return value !== undefined && value.trim() !== "" ? value.trim() : undefined;
}

function envSampleRate(): number | undefined {
  const raw = readEnv("SHADOW_SAMPLE_RATE");
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function envEnabled(): boolean {
  const value = readEnv("SHADOW_ENABLED")?.toLowerCase();
  return !(value === "0" || value === "false" || value === "no" || value === "off");
}

/** Entry point of the SDK: configures the transport and starts traces. */
export class Shadow {
  private readonly options: ShadowOptions;
  private readonly transport: Transport;
  private readonly discard: Transport = new NoopTransport();
  private readonly active = new Set<Trace>();
  private warned = false;

  constructor(options: ShadowOptions = {}) {
    const project = options.project ?? readEnv("SHADOW_PROJECT");
    if (!project) throw new Error("Shadow requires a project slug (option or SHADOW_PROJECT)");
    const sampleRate = options.sampleRate ?? envSampleRate() ?? 1;
    if (!(sampleRate >= 0 && sampleRate <= 1)) {
      throw new Error(`Shadow sampleRate must be between 0 and 1, got ${String(sampleRate)}`);
    }
    this.options = {
      ...options,
      project,
      agent: options.agent ?? readEnv("SHADOW_AGENT"),
      enabled: options.enabled ?? envEnabled(),
      sampleRate,
    };
    this.transport =
      this.options.enabled === false
        ? new NoopTransport()
        : (options.transport ??
          new HttpTransport({
            endpoint: options.endpoint ?? readEnv("SHADOW_ENDPOINT") ?? "http://localhost:4000",
            headers: {
              ...((options.token ?? readEnv("SHADOW_TOKEN"))
                ? { authorization: `Bearer ${options.token ?? readEnv("SHADOW_TOKEN")}` }
                : {}),
              ...(options.headers ?? {}),
            },
          }));
  }

  /** False when recording is disabled (`enabled: false`); traces are then discarded. */
  get enabled(): boolean {
    return this.options.enabled !== false;
  }

  /** Begin recording a new execution. Nothing is sent until the first flush. */
  startTrace(input: StartTraceOptions): Trace {
    const agent = input.agent ?? this.options.agent;
    if (!agent)
      throw new Error(
        "startTrace requires an agent slug (pass `agent` here or in the Shadow options)",
      );
    const redactor =
      this.options.redact === false
        ? (v: JsonValue) => v
        : createRedactor(this.options.redact ?? {});
    const recorded = this.shouldRecord(input);
    const trace = new Trace(recorded ? this.transport : this.discard, {
      name: input.name,
      project: this.options.project as string,
      agent,
      id: input.id,
      metadata: input.metadata,
      tags: input.tags,
      startedAt: input.startedAt,
      flushIntervalMs: this.options.flushIntervalMs ?? 1000,
      maxBatchSize: this.options.maxBatchSize ?? 100,
      snapshotEvery: this.options.snapshotEvery ?? 25,
      onError: (error) => this.handleError(error),
      redact: redactor,
      now: () => Date.now(),
      recorded,
    });
    if (recorded) this.active.add(trace);
    return trace;
  }

  private shouldRecord(input: StartTraceOptions): boolean {
    if (!this.enabled) return false;
    if (input.sample !== undefined) return input.sample;
    if (this.options.sampler) return this.options.sampler(input);
    const rate = this.options.sampleRate ?? 1;
    if (rate >= 1) return true;
    if (rate <= 0) return false;
    return (input.id !== undefined ? hashToUnit(input.id) : Math.random()) < rate;
  }

  /** Flush every active trace. */
  async flush(): Promise<void> {
    await Promise.all([...this.active].map((t) => t.flush()));
  }

  /** Flush and stop timers; call before the process exits. */
  async shutdown(): Promise<void> {
    await this.flush();
    this.active.clear();
  }

  private handleError(error: Error): void {
    if (this.options.onError) {
      this.options.onError(error);
      return;
    }
    if (!this.warned) {
      this.warned = true;
      console.warn(
        `[shadow] failed to send trace data (further failures are silent): ${error.message}`,
      );
    }
  }
}
