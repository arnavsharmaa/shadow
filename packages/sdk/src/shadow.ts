import type { JsonObject, JsonValue } from "@shadow/schemas";
import { createRedactor, type RedactOptions } from "./redact.js";
import { Trace } from "./trace.js";
import { HttpTransport, NoopTransport, type Transport } from "./transport.js";

export interface ShadowOptions {
  /** Project slug traces are recorded under. Created on first use. */
  project: string;
  /** Default agent slug for traces started from this client. */
  agent?: string;
  /** Shadow API base URL. Defaults to `SHADOW_ENDPOINT` or http://localhost:4000. */
  endpoint?: string;
  /** Custom transport (tests, file export, future async transports). */
  transport?: Transport;
  headers?: Record<string, string>;
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
  /** Disable recording entirely (no events are produced or sent). */
  enabled?: boolean;
}

export interface StartTraceOptions {
  name: string;
  agent?: string;
  id?: string;
  metadata?: JsonObject;
  tags?: string[];
  startedAt?: string;
}

function readEnv(name: string): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  return env?.[name];
}

/** Entry point of the SDK: configures the transport and starts traces. */
export class Shadow {
  private readonly options: ShadowOptions;
  private readonly transport: Transport;
  private readonly active = new Set<Trace>();
  private warned = false;

  constructor(options: ShadowOptions) {
    if (!options.project) throw new Error("Shadow requires a project slug");
    this.options = options;
    this.transport =
      options.enabled === false
        ? new NoopTransport()
        : (options.transport ??
          new HttpTransport({
            endpoint: options.endpoint ?? readEnv("SHADOW_ENDPOINT") ?? "http://localhost:4000",
            headers: options.headers,
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
    const trace = new Trace(this.transport, {
      name: input.name,
      project: this.options.project,
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
    });
    this.active.add(trace);
    return trace;
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
