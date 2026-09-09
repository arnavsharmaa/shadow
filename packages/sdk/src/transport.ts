import type {
  Artifact,
  CreateArtifactBodyInput,
  CreateTraceBody,
  IngestEventInput,
  Trace,
} from "@shadow/schemas";

export interface TraceHandle {
  id: string;
  rootBranchId: string;
}

/** Where recorded events go. Implement this to ship traces anywhere. */
export interface Transport {
  createTrace(body: CreateTraceBody): Promise<TraceHandle>;
  sendEvents(traceId: string, events: IngestEventInput[]): Promise<void>;
  /** Attach a document to a trace; optional so custom transports stay minimal. */
  sendArtifact?(traceId: string, artifact: CreateArtifactBodyInput): Promise<Artifact | void>;
}

export class TransportError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "TransportError";
  }
}

export interface HttpTransportOptions {
  /** Base URL of the Shadow API, e.g. `http://localhost:4000`. */
  endpoint: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  /** Attempts per request (network errors and 5xx responses are retried). */
  maxAttempts?: number;
  /** Base backoff in milliseconds (doubles per attempt). */
  backoffMs?: number;
  timeoutMs?: number;
}

/** Sends traces to the Shadow ingestion API over HTTP with retries. */
export class HttpTransport implements Transport {
  private readonly endpoint: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly maxAttempts: number;
  private readonly backoffMs: number;
  private readonly timeoutMs: number;

  constructor(options: HttpTransportOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, "");
    this.headers = { "content-type": "application/json", ...(options.headers ?? {}) };
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.backoffMs = options.backoffMs ?? 250;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (typeof this.fetchImpl !== "function")
      throw new Error("HttpTransport requires a fetch implementation");
  }

  async createTrace(body: CreateTraceBody): Promise<TraceHandle> {
    const trace = (await this.request("POST", "/api/v1/traces", body)) as Trace;
    return { id: trace.id, rootBranchId: trace.rootBranchId };
  }

  async sendEvents(traceId: string, events: IngestEventInput[]): Promise<void> {
    await this.request("POST", `/api/v1/traces/${encodeURIComponent(traceId)}/events`, { events });
  }

  async sendArtifact(traceId: string, artifact: CreateArtifactBodyInput): Promise<Artifact> {
    return (await this.request(
      "POST",
      `/api/v1/traces/${encodeURIComponent(traceId)}/artifacts`,
      artifact,
    )) as Artifact;
  }

  private async request(method: string, path: string, body: unknown): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(`${this.endpoint}${path}`, {
          method,
          headers: this.headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const text = await response.text();
        const parsed = text ? safeJson(text) : null;
        if (response.ok) return parsed;
        const error = new TransportError(
          `${method} ${path} failed with ${response.status}`,
          response.status,
          parsed,
        );
        if (response.status < 500 || attempt === this.maxAttempts) throw error;
        lastError = error;
      } catch (error) {
        if (error instanceof TransportError && error.status !== undefined && error.status < 500)
          throw error;
        lastError = error;
        if (attempt === this.maxAttempts) break;
      } finally {
        clearTimeout(timer);
      }
      await sleep(this.backoffMs * 2 ** (attempt - 1));
    }
    throw lastError instanceof Error ? lastError : new TransportError(String(lastError));
  }
}

/** Keeps everything in memory; useful for tests and offline recording. */
export class MemoryTransport implements Transport {
  readonly traces: CreateTraceBody[] = [];
  readonly events = new Map<string, IngestEventInput[]>();
  readonly artifacts = new Map<string, CreateArtifactBodyInput[]>();
  private counter = 0;

  async createTrace(body: CreateTraceBody): Promise<TraceHandle> {
    this.traces.push(body);
    const id = body.id ?? `trc_mem_${++this.counter}`;
    if (!this.events.has(id)) this.events.set(id, []);
    return { id, rootBranchId: `${id}_main` };
  }

  async sendEvents(traceId: string, events: IngestEventInput[]): Promise<void> {
    this.events.set(traceId, [...(this.events.get(traceId) ?? []), ...events]);
  }

  async sendArtifact(traceId: string, artifact: CreateArtifactBodyInput): Promise<void> {
    this.artifacts.set(traceId, [...(this.artifacts.get(traceId) ?? []), artifact]);
  }

  eventsFor(traceId: string): IngestEventInput[] {
    return this.events.get(traceId) ?? [];
  }

  artifactsFor(traceId: string): CreateArtifactBodyInput[] {
    return this.artifacts.get(traceId) ?? [];
  }
}

/** Discards everything; used when recording is disabled. */
export class NoopTransport implements Transport {
  async createTrace(body: CreateTraceBody): Promise<TraceHandle> {
    return { id: body.id ?? "trc_disabled", rootBranchId: "main" };
  }
  async sendEvents(): Promise<void> {
    return undefined;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
