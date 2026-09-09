import type {
  AgentHost,
  AgentProgram,
  ApprovalRequest,
  ApprovalResolution,
  ContextAccessor,
  CreateArtifactBodyInput,
  EstimatedCost,
  IngestEventInput,
  JsonObject,
  JsonValue,
  ModelCall,
  ModelResult,
  Outcome,
  PolicyCall,
  PolicyEvaluation,
  PolicyResult,
  Severity,
  StateAccessor,
  TokenUsage,
  ToolCall,
  ToolResult,
} from "@shadow/schemas";
import { deepEqual, getAtPointer, removeAtPointer, setAtPointer, toJson } from "./pointer.js";
import type { Transport, TraceHandle } from "./transport.js";

export interface TraceOptions {
  name: string;
  project: string;
  agent: string;
  id?: string;
  metadata?: JsonObject;
  tags?: string[];
  startedAt?: string;
  /** Milliseconds between automatic flushes (0 disables the timer). */
  flushIntervalMs: number;
  maxBatchSize: number;
  onError: (error: Error) => void;
  redact: (value: JsonValue) => JsonValue;
  /** Whether to emit an automatic state snapshot every N mutations (0 disables). */
  snapshotEvery: number;
  now: () => number;
}

interface EmitInput {
  eventType: string;
  name: string;
  input?: JsonValue;
  output?: JsonValue;
  parentEventId?: string | null;
  spanId?: string | null;
  parentSpanId?: string | null;
  durationMs?: number | null;
  severity?: Severity;
  source?: string;
  tags?: string[];
  metadata?: JsonObject;
  tokenUsage?: TokenUsage | null;
  estimatedCost?: EstimatedCost | null;
  stateVersion?: number | null;
  timestamp?: string;
}

interface PendingEvent extends EmitInput {
  id: string;
  sequence: number;
  timestamp: string;
}

export class ToolError extends Error {
  readonly code: string | undefined;
  readonly retryable: boolean | undefined;
  constructor(
    message: string,
    options: { code?: string; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ToolError";
    this.code = options.code;
    this.retryable = options.retryable;
  }
}

export class PolicyBlocked extends Error {
  constructor(
    readonly tool: string,
    readonly evaluation: PolicyEvaluation,
  ) {
    super(`tool '${tool}' blocked by policy '${evaluation.policy}': ${evaluation.decision}`);
    this.name = "PolicyBlocked";
  }
}

/**
 * A live recording of one agent execution. Implements the `AgentHost`
 * contract, so instrumented code and replayable programs share one API.
 */
export class Trace implements AgentHost {
  readonly mode = "record" as const;
  readonly context: ContextAccessor;
  readonly state: StateAccessor;

  private readonly options: TraceOptions;
  private readonly transport: Transport;
  private handle: TraceHandle | null = null;
  private handlePromise: Promise<TraceHandle | null> | null = null;
  private readonly queue: PendingEvent[] = [];
  private readonly artifactQueue: CreateArtifactBodyInput[] = [];
  private lastEmittedId: string | null = null;
  private flushing: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  private sequence = 0;
  private stateVersion = 0;
  private mutations = 0;
  private stateDoc: JsonObject = {};
  private contextDoc: JsonObject = {};
  private readonly agentSpanId: string;
  private spanId: string | null;
  private readonly toolCounts = new Map<string, number>();
  private ended = false;
  private readonly startedAtMs: number;
  readonly id: string;

  constructor(transport: Transport, options: TraceOptions) {
    this.transport = transport;
    this.options = options;
    this.id = options.id ?? newId("trc");
    this.agentSpanId = newId("spn");
    this.spanId = this.agentSpanId;
    this.startedAtMs = options.startedAt ? Date.parse(options.startedAt) : options.now();
    this.context = {
      get: (key) => this.contextDoc[key],
      has: (key) => key in this.contextDoc,
      all: () => structuredClone(this.contextDoc),
      set: (key, value) => this.setContext(key, value),
      remove: (key) => this.removeContext(key),
    };
    this.state = {
      get: () => structuredClone(this.stateDoc),
      at: (path) => getAtPointer(this.stateDoc, path),
      set: (path, value) => this.setState(path, value),
      remove: (path) => this.removeState(path),
      replace: (next) => this.replaceState(next),
    };
    this.emit({
      eventType: "trace.started",
      name: options.name,
      input: { name: options.name, metadata: options.metadata ?? {} },
      spanId: null,
      tags: options.tags,
      timestamp: new Date(this.startedAtMs).toISOString(),
    });
    this.emit({
      eventType: "agent.started",
      name: options.agent,
      input: { agent: options.agent },
      spanId: this.agentSpanId,
      parentSpanId: null,
    });
    if (options.flushIntervalMs > 0) {
      this.timer = setInterval(() => void this.flush(), options.flushIntervalMs);
      if (typeof this.timer === "object" && "unref" in this.timer) this.timer.unref();
    }
  }

  get traceId(): string {
    return this.id;
  }

  get branchId(): string {
    return this.handle?.rootBranchId ?? "main";
  }

  /** Attach the original request to the agent span (replays read it from here). */
  setInput(input: JsonValue): void {
    const started = this.queue.find((e) => e.eventType === "agent.started");
    if (started) started.input = { agent: this.options.agent, request: toJson(input) };
  }

  // ---- events -------------------------------------------------------------

  private emit(partial: EmitInput): PendingEvent {
    const event: PendingEvent = {
      id: newId("evt"),
      sequence: this.sequence++,
      timestamp: partial.timestamp ?? new Date(this.options.now()).toISOString(),
      severity: "info",
      source: "sdk",
      ...partial,
      spanId: partial.spanId === undefined ? this.spanId : partial.spanId,
      input: partial.input === undefined ? undefined : this.options.redact(toJson(partial.input)),
      output:
        partial.output === undefined ? undefined : this.options.redact(toJson(partial.output)),
      metadata: partial.metadata
        ? (this.options.redact(toJson(partial.metadata)) as JsonObject)
        : undefined,
      tokenUsage: partial.tokenUsage ?? undefined,
      estimatedCost: partial.estimatedCost ?? undefined,
    };
    this.queue.push(event);
    this.lastEmittedId = event.id;
    if (this.queue.length >= this.options.maxBatchSize) void this.flush();
    return event;
  }

  /** Send buffered events. Never throws; failures go to `onError`. */
  flush(): Promise<void> {
    this.flushing = this.flushing.then(() => this.flushNow());
    return this.flushing;
  }

  private async flushNow(): Promise<void> {
    if (this.queue.length === 0 && this.artifactQueue.length === 0) return;
    const handle = await this.ensureHandle();
    if (!handle) return;
    const batch = this.queue.splice(0, this.queue.length);
    try {
      if (batch.length > 0) await this.transport.sendEvents(handle.id, batch as IngestEventInput[]);
      // Artifacts go after their events so `eventId` links resolve on the server.
      const artifacts = this.artifactQueue.splice(0, this.artifactQueue.length);
      for (const artifact of artifacts) {
        if (this.transport.sendArtifact) await this.transport.sendArtifact(handle.id, artifact);
      }
    } catch (error) {
      this.options.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /** Id of the most recently recorded event (handy for `artifact({ eventId })`). */
  get lastEventId(): string | null {
    return this.lastEmittedId;
  }

  /**
   * Attach a document (an email body, a retrieved page, a generated report)
   * to this trace. Pass `eventId` (for example `trace.lastEventId`) to link it
   * to the event that produced it. Sent on the next flush.
   */
  artifact(input: {
    kind: string;
    name: string;
    content: JsonValue;
    contentType?: string;
    eventId?: string;
  }): void {
    this.artifactQueue.push({
      kind: input.kind,
      name: input.name,
      contentType: input.contentType ?? "application/json",
      content: this.options.redact(toJson(input.content)),
      ...(input.eventId ? { eventId: input.eventId } : {}),
    });
  }

  private ensureHandle(): Promise<TraceHandle | null> {
    if (this.handle) return Promise.resolve(this.handle);
    if (!this.handlePromise) {
      this.handlePromise = this.transport
        .createTrace({
          id: this.id,
          project: this.options.project,
          agent: this.options.agent,
          name: this.options.name,
          startedAt: new Date(this.startedAtMs).toISOString(),
          tags: this.options.tags,
          metadata: this.options.metadata,
        })
        .then((handle) => {
          this.handle = handle;
          return handle;
        })
        .catch((error: unknown) => {
          this.options.onError(error instanceof Error ? error : new Error(String(error)));
          this.handlePromise = null;
          this.queue.length = 0;
          return null;
        });
    }
    return this.handlePromise;
  }

  // ---- state & context ----------------------------------------------------

  private bump(): void {
    this.stateVersion++;
    this.mutations++;
    if (this.options.snapshotEvery > 0 && this.mutations >= this.options.snapshotEvery) {
      this.mutations = 0;
      this.emit({
        eventType: "state.snapshot",
        name: "auto-snapshot",
        output: { state: this.stateDoc, context: this.contextDoc },
        stateVersion: this.stateVersion,
        metadata: { auto: true },
        severity: "debug",
      });
    }
  }

  private setContext(key: string, value: JsonValue): void {
    const json = toJson(value);
    if (key in this.contextDoc && deepEqual(this.contextDoc[key], json)) return;
    this.contextDoc = { ...this.contextDoc, [key]: json };
    this.bump();
    this.emit({
      eventType: "context.added",
      name: key,
      output: { key, value: json },
      stateVersion: this.stateVersion,
    });
  }

  private removeContext(key: string): void {
    if (!(key in this.contextDoc)) return;
    const { [key]: _removed, ...rest } = this.contextDoc;
    this.contextDoc = rest;
    this.bump();
    this.emit({
      eventType: "context.removed",
      name: key,
      output: { key },
      stateVersion: this.stateVersion,
    });
  }

  private setState(path: string, value: JsonValue): void {
    const json = toJson(value);
    const existing = getAtPointer(this.stateDoc, path);
    if (deepEqual(existing, json)) return;
    this.stateDoc = setAtPointer(this.stateDoc, path, json) as JsonObject;
    this.bump();
    this.emit({
      eventType: "state.patch",
      name: path === "" ? "(root)" : path,
      output: { ops: [{ op: existing === undefined ? "add" : "replace", path, value: json }] },
      stateVersion: this.stateVersion,
    });
  }

  private removeState(path: string): void {
    if (getAtPointer(this.stateDoc, path) === undefined) return;
    this.stateDoc = removeAtPointer(this.stateDoc, path) as JsonObject;
    this.bump();
    this.emit({
      eventType: "state.patch",
      name: path,
      output: { ops: [{ op: "remove", path }] },
      stateVersion: this.stateVersion,
    });
  }

  private replaceState(next: JsonObject): void {
    const json = toJson(next) as JsonObject;
    if (deepEqual(this.stateDoc, json)) return;
    this.stateDoc = json;
    this.bump();
    this.emit({
      eventType: "state.patch",
      name: "(root)",
      output: { ops: [{ op: "replace", path: "", value: json }] },
      stateVersion: this.stateVersion,
    });
  }

  snapshot(): void {
    this.mutations = 0;
    this.emit({
      eventType: "state.snapshot",
      name: "snapshot",
      output: { state: this.stateDoc, context: this.contextDoc },
      stateVersion: this.stateVersion,
    });
  }

  note(name: string, data?: JsonValue): void {
    this.emit({
      eventType: "agent.note",
      name,
      output: data === undefined ? null : data,
      severity: "debug",
    });
  }

  // ---- operations ---------------------------------------------------------

  async tool(call: ToolCall): Promise<JsonValue> {
    if (!call.execute)
      throw new Error(`tool '${call.name}' needs an execute() implementation when recording live`);
    const args = toJson(call.arguments);
    const occurrence = (this.toolCounts.get(call.name) ?? 0) + 1;
    this.toolCounts.set(call.name, occurrence);
    const spanId = newId("spn");
    const parentSpanId = this.spanId;
    const started = this.options.now();
    const request = this.emit({
      eventType: "tool.request",
      name: call.name,
      input: { tool: call.name, arguments: args },
      spanId,
      parentSpanId,
      tags: call.tags,
      metadata: call.metadata,
    });
    const previousSpan = this.spanId;
    this.spanId = spanId;
    try {
      if (call.guard) {
        const evaluation = await this.evaluatePolicy(call.guard, request.id);
        if (evaluation.decision !== "allow") {
          this.emit({
            eventType: "tool.error",
            name: call.name,
            input: { tool: call.name, arguments: args },
            output: {
              error: {
                message: `blocked by policy ${evaluation.policy}: ${evaluation.reason ?? evaluation.decision}`,
                code: "policy_blocked",
                retryable: false,
              },
            },
            parentEventId: request.id,
            spanId,
            parentSpanId,
            durationMs: this.options.now() - started,
            severity: "warn",
          });
          throw new PolicyBlocked(call.name, evaluation);
        }
      }
      const raw = await call.execute(args, {
        context: structuredClone(this.contextDoc),
        state: structuredClone(this.stateDoc),
        occurrence,
      });
      const result = normaliseToolResult(raw);
      const jsonResult = toJson(result.result);
      this.emit({
        eventType: "tool.response",
        name: call.name,
        input: { tool: call.name, arguments: args },
        output: { result: jsonResult },
        parentEventId: request.id,
        spanId,
        parentSpanId,
        durationMs: this.options.now() - started,
        estimatedCost:
          result.estimatedCost !== undefined
            ? { amount: result.estimatedCost, currency: "USD" }
            : undefined,
        tags: call.tags,
      });
      return jsonResult;
    } catch (error) {
      if (error instanceof PolicyBlocked) throw error;
      const wrapped = error instanceof ToolError ? error : wrapError(error);
      this.emit({
        eventType: "tool.error",
        name: call.name,
        input: { tool: call.name, arguments: args },
        output: {
          error: {
            message: wrapped.message,
            ...(wrapped.code ? { code: wrapped.code } : {}),
            ...(wrapped.retryable !== undefined ? { retryable: wrapped.retryable } : {}),
          },
        },
        parentEventId: request.id,
        spanId,
        parentSpanId,
        durationMs: this.options.now() - started,
        severity: "error",
        tags: call.tags,
      });
      throw wrapped;
    } finally {
      this.spanId = previousSpan;
    }
  }

  async model(call: ModelCall): Promise<ModelResult> {
    if (!call.execute)
      throw new Error(
        `model call '${call.name ?? call.model}' needs an execute() implementation when recording live`,
      );
    const name = call.name ?? call.model;
    const request = {
      provider: call.provider,
      model: call.model,
      messages: toJson(call.messages),
      ...(call.parameters ? { parameters: toJson(call.parameters) } : {}),
    };
    const spanId = newId("spn");
    const parentSpanId = this.spanId;
    const started = this.options.now();
    const requestEvent = this.emit({
      eventType: "model.request",
      name,
      input: request,
      spanId,
      parentSpanId,
      tags: call.tags,
      metadata: call.metadata,
    });
    const result = await call.execute({
      provider: call.provider,
      model: call.model,
      messages: call.messages,
      parameters: call.parameters,
    });
    const tokenUsage: TokenUsage | undefined = result.tokenUsage;
    const estimatedCost: EstimatedCost | undefined =
      result.estimatedCost !== undefined
        ? {
            amount: result.estimatedCost,
            currency: "USD",
            provider: call.provider,
            model: call.model,
          }
        : undefined;
    const output = toJson({
      message: result.message,
      ...(result.finishReason ? { finishReason: result.finishReason } : {}),
      ...(result.toolCalls ? { toolCalls: result.toolCalls } : {}),
    });
    this.emit({
      eventType: "model.response",
      name,
      input: { provider: call.provider, model: call.model },
      output,
      parentEventId: requestEvent.id,
      spanId,
      parentSpanId,
      durationMs: this.options.now() - started,
      tokenUsage,
      estimatedCost,
      tags: call.tags,
    });
    return result;
  }

  async policy(call: PolicyCall): Promise<PolicyEvaluation> {
    return this.evaluatePolicy(call, null);
  }

  private async evaluatePolicy(
    call: PolicyCall,
    parentEventId: string | null,
  ): Promise<PolicyEvaluation> {
    if (!call.evaluate)
      throw new Error(
        `policy '${call.policy}' needs an evaluate() implementation when recording live`,
      );
    const subject = toJson(call.subject);
    const config = call.config ?? {};
    const result: PolicyResult = await call.evaluate({
      context: structuredClone(this.contextDoc),
      state: structuredClone(this.stateDoc),
      config,
    });
    const severity: Severity = result.decision === "allow" ? "info" : "warn";
    const evaluated = this.emit({
      eventType: "policy.evaluated",
      name: call.policy,
      input: { policy: call.policy, subject, config },
      output: {
        policy: call.policy,
        decision: result.decision,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.details ? { details: result.details } : {}),
      },
      parentEventId,
      severity,
    });
    this.emit({
      eventType:
        result.decision === "allow"
          ? "policy.allowed"
          : result.decision === "deny"
            ? "policy.denied"
            : "policy.approval_required",
      name: call.policy,
      output: {
        policy: call.policy,
        decision: result.decision,
        ...(result.reason ? { reason: result.reason } : {}),
      },
      parentEventId: evaluated.id,
      severity,
    });
    return {
      policy: call.policy,
      decision: result.decision,
      reason: result.reason,
      details: result.details,
      eventId: evaluated.id,
    };
  }

  async requestApproval(request: ApprovalRequest): Promise<ApprovalResolution> {
    const approvalId = newId("apr");
    this.emit({
      eventType: "human.approval_requested",
      name: "approval",
      input: toJson(request),
      output: {
        approvalId,
        reason: request.reason,
        status: "pending",
        ...(request.request !== undefined ? { request: request.request } : {}),
      },
      severity: "warn",
    });
    return { approvalId, decision: "pending" };
  }

  /** Record the outcome of a previously requested approval. */
  resolveApproval(
    approvalId: string,
    decision: "approved" | "rejected",
    resolvedBy?: string,
  ): void {
    this.emit({
      eventType: "human.approval_resolved",
      name: "approval",
      output: { approvalId, decision, ...(resolvedBy ? { resolvedBy } : {}) },
    });
  }

  // ---- lifecycle ----------------------------------------------------------

  /** Run a program against this trace, ending or failing it automatically. */
  async run<Input extends JsonValue>(
    program: AgentProgram<Input>,
    input: Input,
  ): Promise<Outcome | null> {
    this.setInput(input);
    try {
      const outcome = (await program(this, input)) ?? null;
      await this.end({ outcome: outcome ?? undefined });
      return outcome;
    } catch (error) {
      await this.fail(error);
      throw error;
    }
  }

  async end(options: { outcome?: Outcome } = {}): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    const outcome = options.outcome ?? { kind: "completed", label: "Completed" };
    this.emit({
      eventType: "agent.completed",
      name: this.options.agent,
      output: toJson({ outcome }),
      spanId: this.agentSpanId,
      parentSpanId: null,
      durationMs: this.options.now() - this.startedAtMs,
    });
    const violation = outcome.kind === "policy_violation";
    this.emit({
      eventType: violation ? "trace.failed" : "trace.completed",
      name: violation ? "trace.failed" : "trace.completed",
      output: toJson({ outcome }),
      spanId: null,
      severity: violation ? "error" : "info",
    });
    await this.close();
  }

  async fail(error: unknown): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    const err =
      error instanceof Error
        ? { message: error.message, name: error.name }
        : { message: String(error) };
    const outcome: Outcome = { kind: "error", label: `Failed: ${err.message}` };
    this.emit({
      eventType: "agent.completed",
      name: this.options.agent,
      output: toJson({ error: err }),
      spanId: this.agentSpanId,
      parentSpanId: null,
      durationMs: this.options.now() - this.startedAtMs,
      severity: "error",
    });
    this.emit({
      eventType: "trace.failed",
      name: "trace.failed",
      output: toJson({ error: err, outcome }),
      spanId: null,
      severity: "error",
    });
    await this.close();
  }

  private async close(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
  }
}

function normaliseToolResult(raw: ToolResult | JsonValue): ToolResult {
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw) && "result" in raw) {
    const r = raw as ToolResult;
    return { result: r.result, latencyMs: r.latencyMs, estimatedCost: r.estimatedCost };
  }
  return { result: raw as JsonValue };
}

function wrapError(error: unknown): ToolError {
  if (error instanceof Error) {
    const maybe = error as Error & { code?: unknown; retryable?: unknown };
    return new ToolError(error.message, {
      code: typeof maybe.code === "string" ? maybe.code : undefined,
      retryable: typeof maybe.retryable === "boolean" ? maybe.retryable : undefined,
      cause: error,
    });
  }
  return new ToolError(String(error));
}

export function newId(prefix: string): string {
  return `${prefix}_${globalThis.crypto.randomUUID().replace(/-/g, "")}`;
}
