import type {
  AgentHost,
  ApprovalRequest,
  ApprovalResolution,
  ContextAccessor,
  JsonObject,
  JsonValue,
  ModelCall,
  ModelRequestPayload,
  ModelResult,
  Override,
  PolicyCall,
  PolicyDecision,
  PolicyEvaluation,
  PolicyResult,
  ShadowEvent,
  StateAccessor,
  ToolCall,
  ToolResult,
  TokenUsage,
} from "@shadow/schemas";
import {
  contextAddedPayloadSchema,
  contextRemovedPayloadSchema,
  modelResponsePayloadSchema,
  policyEvaluationPayloadSchema,
  statePatchPayloadSchema,
  stateSnapshotPayloadSchema,
  toolErrorPayloadSchema,
  toolResponsePayloadSchema,
} from "@shadow/schemas";
import type { Clock } from "../clock.js";
import { deepClone, toJson } from "../json.js";
import { estimateModelCost, type PricingProvider } from "../metrics/pricing.js";
import { getAtPointer } from "../state/pointer.js";
import { DEFAULT_SNAPSHOT_POLICY, type SnapshotPolicy } from "../state/reconstruct.js";
import { applyPatch } from "../state/patch.js";
import type { StateStore } from "../state/store.js";
import type { EventLog } from "./event-log.js";
import { isOverrideOrigin, type HistoryCursor } from "./history.js";
import {
  POLICY_BLOCKED_CODE,
  PolicyBlockedError,
  ReplayHistoryMismatchError,
  ToolExecutionError,
  type Adapters,
} from "./types.js";

export interface RuntimeHostOptions {
  traceId: string;
  branchId: string;
  mode: "record" | "replay";
  log: EventLog;
  store: StateStore;
  clock: Clock;
  adapters: Adapters;
  /** `callbacks`: prefer `execute`/`evaluate` callbacks (live). `adapters`: always adapters. */
  execution: "callbacks" | "adapters";
  pricing?: PricingProvider;
  snapshotPolicy?: SnapshotPolicy;
  policyConfig?: Record<string, JsonObject>;
  /** Recorded prefix to serve before going live (replay only). */
  history?: HistoryCursor;
  /** Overrides applied when the replay goes live (replay only). */
  overrides?: Override[];
  /** Called once when the host transitions from history to live execution. */
  onLive?: (host: RuntimeHost) => void;
}

/**
 * Runtime that executes an agent program while recording every operation.
 * With a `history` cursor it first serves recorded results (deterministic
 * prefix), then switches to live execution against adapters and overrides.
 */
export class RuntimeHost implements AgentHost {
  readonly traceId: string;
  readonly branchId: string;
  readonly mode: "record" | "replay";
  readonly context: ContextAccessor;
  readonly state: StateAccessor;

  private readonly log: EventLog;
  private readonly store: StateStore;
  private readonly clock: Clock;
  private readonly adapters: Adapters;
  private readonly execution: "callbacks" | "adapters";
  private readonly pricing: PricingProvider | undefined;
  private readonly snapshotPolicy: SnapshotPolicy;
  private readonly policyConfig: Record<string, JsonObject>;
  private history: HistoryCursor | null;
  private readonly onLive: ((host: RuntimeHost) => void) | undefined;
  private live: boolean;
  private mutationsSinceSnapshot = 0;
  private readonly toolOccurrences = new Map<string, number>();
  private readonly toolOccurrencesSinceLive = new Map<string, number>();
  private readonly toolOverrides: Override[];
  private readonly policyOverrides = new Map<string, JsonObject>();
  private spanId: string | null = null;
  private correlationId: string | null = null;

  constructor(options: RuntimeHostOptions) {
    this.traceId = options.traceId;
    this.branchId = options.branchId;
    this.mode = options.mode;
    this.log = options.log;
    this.store = options.store;
    this.clock = options.clock;
    this.adapters = options.adapters;
    this.execution = options.execution;
    this.pricing = options.pricing;
    this.snapshotPolicy = options.snapshotPolicy ?? DEFAULT_SNAPSHOT_POLICY;
    this.policyConfig = options.policyConfig ?? {};
    this.history = options.history ?? null;
    this.onLive = options.onLive;
    this.live = this.history === null;
    this.toolOverrides = (options.overrides ?? []).filter(
      (o) => o.kind === "tool_result" || o.kind === "tool_error",
    );
    for (const override of options.overrides ?? []) {
      if (override.kind === "policy") this.policyOverrides.set(override.policy, override.config);
    }
    this.context = {
      get: (key) => this.store.getContext()[key],
      has: (key) => key in this.store.getContext(),
      all: () => this.store.getContext(),
      set: (key, value) => this.setContext(key, value),
      remove: (key) => this.removeContext(key),
    };
    this.state = {
      get: () => this.store.getState(),
      at: (path) => getAtPointer(this.store.getState(), path),
      set: (path, value) => this.setState(path, value),
      remove: (path) => this.removeState(path),
      replace: (next) => this.replaceState(next),
    };
  }

  // ---- span management ----------------------------------------------------

  get currentSpanId(): string | null {
    return this.spanId;
  }

  get isLive(): boolean {
    return this.live;
  }

  get events(): readonly ShadowEvent[] {
    return this.log.events;
  }

  get now(): number {
    return this.clock.now();
  }

  setCorrelationId(id: string | null) {
    this.correlationId = id;
  }

  /** Open a span and run `fn` inside it (used for the agent span). */
  async withSpan<T>(spanId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.spanId;
    this.spanId = spanId;
    try {
      return await fn();
    } finally {
      this.spanId = previous;
    }
  }

  emit(input: Parameters<EventLog["emit"]>[0]): ShadowEvent {
    return this.log.emit({
      spanId: this.spanId,
      correlationId: this.correlationId,
      ...input,
    });
  }

  // ---- history / live switching -------------------------------------------

  /** Serve the next recorded op, or switch to live mode and return null. */
  private serve(eventType: string, name: string, input?: JsonValue) {
    if (this.live || !this.history) return null;
    const served = this.history.serve(eventType, name, input);
    if (served) {
      this.applySkipped(served.skipped);
      return served;
    }
    this.goLive();
    return null;
  }

  private applySkipped(skipped: readonly ShadowEvent[]) {
    // Override events written by an ancestor fork mutate state outside the program.
    for (const event of skipped) {
      if (!isOverrideOrigin(event)) continue;
      this.applyRecordedMutation(event);
    }
  }

  private applyRecordedMutation(event: ShadowEvent) {
    switch (event.eventType) {
      case "context.added": {
        const p = contextAddedPayloadSchema.parse(event.output);
        this.store.setContext(p.key, p.value);
        break;
      }
      case "context.removed": {
        const p = contextRemovedPayloadSchema.parse(event.output);
        this.store.removeContext(p.key);
        break;
      }
      case "state.patch": {
        const p = statePatchPayloadSchema.parse(event.output);
        const next = applyPatch(this.store.getState(), p.ops);
        this.store.replaceState(next as JsonObject);
        break;
      }
      case "state.snapshot": {
        const p = stateSnapshotPayloadSchema.parse(event.output);
        this.store.load(p.state, p.context, event.stateVersion ?? this.store.version);
        break;
      }
      default:
        break;
    }
  }

  /** Transition to live execution: drain remaining history, notify listener. */
  goLive(): void {
    if (this.live) return;
    this.live = true;
    if (this.history) {
      this.applySkipped(this.history.drain());
      this.history = null;
    }
    this.onLive?.(this);
  }

  /** Apply context/state overrides now (called by the replay engine when going live). */
  applyStateOverrides(overrides: readonly Override[], metadata: JsonObject): void {
    for (const override of overrides) {
      const overrideMeta: JsonObject = {
        ...metadata,
        shadow: {
          ...(isObj(metadata.shadow) ? metadata.shadow : {}),
          origin: "override",
          overrideKind: override.kind,
          ...(override.id ? { overrideId: override.id } : {}),
        },
      };
      if (override.kind === "context") {
        if (override.op === "set") {
          this.store.setContext(override.key, override.value ?? null);
          this.emit({
            eventType: "context.added",
            name: override.key,
            output: { key: override.key, value: override.value ?? null },
            stateVersion: this.store.version,
            metadata: overrideMeta,
            tags: ["override"],
          });
        } else {
          this.store.removeContext(override.key);
          this.emit({
            eventType: "context.removed",
            name: override.key,
            output: { key: override.key },
            stateVersion: this.store.version,
            metadata: overrideMeta,
            tags: ["override"],
          });
        }
      } else if (override.kind === "state") {
        const ops =
          override.op === "set"
            ? this.store.setState(override.path, override.value ?? null)
            : this.store.removeState(override.path);
        this.emit({
          eventType: "state.patch",
          name: override.path === "" ? "(root)" : override.path,
          output: { ops: ops ?? [] },
          stateVersion: this.store.version,
          metadata: overrideMeta,
          tags: ["override"],
        });
      }
    }
  }

  // ---- context & state ------------------------------------------------------

  private bumpMutations() {
    this.mutationsSinceSnapshot++;
    if (this.mutationsSinceSnapshot >= this.snapshotPolicy.everyMutations) {
      this.mutationsSinceSnapshot = 0;
      this.emit({
        eventType: "state.snapshot",
        name: "auto-snapshot",
        output: { state: this.store.getState(), context: this.store.getContext() },
        stateVersion: this.store.version,
        metadata: { auto: true },
        severity: "debug",
      });
    }
  }

  private setContext(key: string, value: JsonValue) {
    const json = toJson(value);
    const served = this.serve("context.added", key, undefined);
    if (served) {
      this.store.setContext(key, json);
      return;
    }
    if (!this.store.setContext(key, json)) return;
    this.emit({
      eventType: "context.added",
      name: key,
      output: { key, value: json },
      stateVersion: this.store.version,
    });
    this.bumpMutations();
  }

  private removeContext(key: string) {
    const served = this.serve("context.removed", key, undefined);
    if (served) {
      this.store.removeContext(key);
      return;
    }
    if (!this.store.removeContext(key)) return;
    this.emit({
      eventType: "context.removed",
      name: key,
      output: { key },
      stateVersion: this.store.version,
    });
    this.bumpMutations();
  }

  private setState(path: string, value: JsonValue) {
    const json = toJson(value);
    const served = this.serve("state.patch", path === "" ? "(root)" : path, undefined);
    if (served) {
      this.store.setState(path, json);
      return;
    }
    const ops = this.store.setState(path, json);
    if (!ops) return;
    this.emit({
      eventType: "state.patch",
      name: path,
      output: { ops },
      stateVersion: this.store.version,
    });
    this.bumpMutations();
  }

  private removeState(path: string) {
    const served = this.serve("state.patch", path, undefined);
    if (served) {
      this.store.removeState(path);
      return;
    }
    const ops = this.store.removeState(path);
    if (!ops) return;
    this.emit({
      eventType: "state.patch",
      name: path,
      output: { ops },
      stateVersion: this.store.version,
    });
    this.bumpMutations();
  }

  private replaceState(next: JsonObject) {
    const json = toJson(next) as JsonObject;
    const served = this.serve("state.patch", "(root)", undefined);
    if (served) {
      this.store.replaceState(json);
      return;
    }
    const ops = this.store.replaceState(json);
    if (!ops) return;
    this.emit({
      eventType: "state.patch",
      name: "(root)",
      output: { ops },
      stateVersion: this.store.version,
    });
    this.bumpMutations();
  }

  snapshot(): void {
    const served = this.serve("state.snapshot", "snapshot", undefined);
    if (served) return;
    this.mutationsSinceSnapshot = 0;
    this.emit({
      eventType: "state.snapshot",
      name: "snapshot",
      output: { state: this.store.getState(), context: this.store.getContext() },
      stateVersion: this.store.version,
    });
  }

  note(name: string, data?: JsonValue): void {
    const served = this.serve("agent.note", name, undefined);
    if (served) return;
    this.emit({
      eventType: "agent.note",
      name,
      output: data === undefined ? null : toJson(data),
      severity: "debug",
    });
  }

  // ---- tools ----------------------------------------------------------------

  async tool(call: ToolCall): Promise<JsonValue> {
    const args = toJson(call.arguments);
    const occurrence = (this.toolOccurrences.get(call.name) ?? 0) + 1;
    this.toolOccurrences.set(call.name, occurrence);

    const served = this.serve("tool.request", call.name, { tool: call.name, arguments: args });
    if (served) {
      // Guard evaluations are children of the request in the recorded span; skip them.
      for (const child of served.children) {
        if (child.eventType === "tool.response") {
          return deepClone(toolResponsePayloadSchema.parse(child.output).result);
        }
        if (child.eventType === "tool.error") {
          const payload = toolErrorPayloadSchema.parse(child.output);
          if (payload.error.code === POLICY_BLOCKED_CODE) {
            const evaluated = served.children.find((c) => c.eventType === "policy.evaluated");
            const evaluation = evaluated
              ? policyEvaluationPayloadSchema.parse(evaluated.output)
              : null;
            throw new PolicyBlockedError({
              tool: call.name,
              evaluation: {
                policy: evaluation?.policy ?? call.guard?.policy ?? "unknown",
                decision: evaluation?.decision ?? "deny",
                reason: evaluation?.reason,
                details: evaluation?.details,
                eventId: evaluated?.id ?? served.event.id,
              },
            });
          }
          throw new ToolExecutionError(payload.error.message, {
            code: payload.error.code,
            retryable: payload.error.retryable,
          });
        }
      }
      throw new ReplayHistoryMismatchError(
        `recorded tool.request '${call.name}' (sequence ${served.event.sequence}) has no response or error`,
        { eventId: served.event.id },
      );
    }

    const spanId = this.log.newSpanId();
    const parentSpanId = this.spanId;
    const started = this.clock.now();
    const request = this.emit({
      eventType: "tool.request",
      name: call.name,
      input: { tool: call.name, arguments: args },
      spanId,
      parentSpanId,
      tags: call.tags,
      metadata: call.metadata,
    });

    const inSpan = <T>(fn: () => Promise<T>) => this.withSpan(spanId, fn);

    if (call.guard) {
      const evaluation = await inSpan(() =>
        this.evaluatePolicy(call.guard as PolicyCall, request.id),
      );
      if (evaluation.decision !== "allow") {
        this.emit({
          eventType: "tool.error",
          name: call.name,
          input: { tool: call.name, arguments: args },
          output: {
            error: {
              message: `blocked by policy ${evaluation.policy}: ${evaluation.reason ?? evaluation.decision}`,
              code: POLICY_BLOCKED_CODE,
              retryable: false,
            },
          },
          parentEventId: request.id,
          spanId,
          parentSpanId,
          durationMs: this.clock.now() - started,
          severity: "warn",
          tags: call.tags,
        });
        throw new PolicyBlockedError({ tool: call.name, evaluation });
      }
    }

    const sinceLive = (this.toolOccurrencesSinceLive.get(call.name) ?? 0) + 1;
    this.toolOccurrencesSinceLive.set(call.name, sinceLive);
    const override = this.toolOverrides.find(
      (o) =>
        (o.kind === "tool_result" || o.kind === "tool_error") &&
        o.tool === call.name &&
        o.occurrence === sinceLive,
    );

    try {
      let result: ToolResult;
      let overrideMeta: JsonObject | undefined;
      if (override?.kind === "tool_error") {
        overrideMeta = overrideMetadata(override);
        throw new ToolExecutionError(override.error.message, {
          code: override.error.code,
          retryable: override.error.retryable,
          cause: overrideMeta,
        });
      } else if (override?.kind === "tool_result") {
        overrideMeta = overrideMetadata(override);
        result = { result: deepClone(override.result), latencyMs: 0 };
      } else {
        const ctx = {
          context: this.store.getContext(),
          state: this.store.getState(),
          occurrence,
          now: this.clock.now(),
        };
        const useCallback = this.execution === "callbacks" && call.execute;
        const raw = useCallback
          ? await (call.execute as NonNullable<ToolCall["execute"]>)(args, ctx)
          : await this.adapters.tools.execute({ tool: call.name, arguments: args }, ctx);
        result = normaliseToolResult(raw);
      }
      const latency = result.latencyMs ?? 0;
      this.clock.advance(latency);
      const jsonResult = toJson(result.result);
      this.emit({
        eventType: "tool.response",
        name: call.name,
        input: { tool: call.name, arguments: args },
        output: { result: jsonResult },
        parentEventId: request.id,
        spanId,
        parentSpanId,
        durationMs: this.clock.now() - started,
        estimatedCost:
          result.estimatedCost !== undefined
            ? { amount: result.estimatedCost, currency: "USD" }
            : null,
        tags: call.tags,
        metadata: overrideMeta,
      });
      return jsonResult;
    } catch (error) {
      if (error instanceof PolicyBlockedError) throw error;
      const toolError = error instanceof ToolExecutionError ? error : wrapError(error);
      const latency = extractLatency(error);
      this.clock.advance(latency);
      this.emit({
        eventType: "tool.error",
        name: call.name,
        input: { tool: call.name, arguments: args },
        output: {
          error: {
            message: toolError.message,
            ...(toolError.code ? { code: toolError.code } : {}),
            ...(toolError.retryable !== undefined ? { retryable: toolError.retryable } : {}),
          },
        },
        parentEventId: request.id,
        spanId,
        parentSpanId,
        durationMs: this.clock.now() - started,
        severity: "error",
        tags: call.tags,
        metadata: override ? overrideMetadata(override) : undefined,
      });
      throw toolError;
    }
  }

  // ---- models ---------------------------------------------------------------

  async model(call: ModelCall): Promise<ModelResult> {
    const name = call.name ?? call.model;
    const request: ModelRequestPayload = {
      provider: call.provider,
      model: call.model,
      messages: toJson(call.messages) as ModelCall["messages"],
      ...(call.parameters ? { parameters: toJson(call.parameters) as JsonObject } : {}),
    };
    const requestJson = toJson(request);
    const served = this.serve("model.request", name, requestJson);
    if (served) {
      const response = served.children.find((c) => c.eventType === "model.response");
      if (!response) {
        throw new ReplayHistoryMismatchError(`recorded model.request '${name}' has no response`, {
          eventId: served.event.id,
        });
      }
      const payload = modelResponsePayloadSchema.parse(response.output);
      return { ...structuredClone(payload), tokenUsage: response.tokenUsage ?? undefined };
    }

    const spanId = this.log.newSpanId();
    const parentSpanId = this.spanId;
    const started = this.clock.now();
    const requestEvent = this.emit({
      eventType: "model.request",
      name,
      input: requestJson,
      spanId,
      parentSpanId,
      tags: call.tags,
      metadata: call.metadata,
    });
    const ctx = {
      context: this.store.getContext(),
      state: this.store.getState(),
      now: this.clock.now(),
    };
    const useCallback = this.execution === "callbacks" && call.execute;
    const result = useCallback
      ? await (call.execute as NonNullable<ModelCall["execute"]>)(request)
      : await this.adapters.model.complete(request, ctx);
    const latency = result.latencyMs ?? 0;
    this.clock.advance(latency);
    const tokenUsage: TokenUsage | null = result.tokenUsage ?? null;
    const estimatedCost = tokenUsage
      ? estimateModelCost(tokenUsage, this.pricing?.lookup(call.provider, call.model))
      : null;
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
      durationMs: this.clock.now() - started,
      tokenUsage,
      estimatedCost,
      tags: call.tags,
    });
    return { ...modelResponsePayloadSchema.parse(output), tokenUsage: tokenUsage ?? undefined };
  }

  // ---- policies -------------------------------------------------------------

  async policy(call: PolicyCall): Promise<PolicyEvaluation> {
    return this.evaluatePolicy(call, null);
  }

  private async evaluatePolicy(
    call: PolicyCall,
    parentEventId: string | null,
  ): Promise<PolicyEvaluation> {
    const subject = toJson(call.subject);
    const served = this.serve("policy.evaluated", call.policy, undefined);
    if (served) {
      const payload = policyEvaluationPayloadSchema.parse(served.event.output);
      return {
        policy: payload.policy,
        decision: payload.decision,
        reason: payload.reason,
        details: payload.details,
        eventId: served.event.id,
      };
    }
    const config: JsonObject = {
      ...(this.policyConfig[call.policy] ?? {}),
      ...(call.config ?? {}),
      ...(this.policyOverrides.get(call.policy) ?? {}),
    };
    const ctx = {
      context: this.store.getContext(),
      state: this.store.getState(),
      config,
      now: this.clock.now(),
    };
    const useCallback = this.execution === "callbacks" && call.evaluate;
    const result: PolicyResult = useCallback
      ? await (call.evaluate as NonNullable<PolicyCall["evaluate"]>)(ctx)
      : await this.adapters.policies.evaluate({ policy: call.policy, subject }, ctx);
    const overridden = this.policyOverrides.has(call.policy);
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
      severity: result.decision === "allow" ? "info" : "warn",
      metadata: overridden ? { shadow: { overrideKind: "policy" } } : undefined,
    });
    this.emit({
      eventType: outcomeEventType(result.decision),
      name: call.policy,
      output: {
        policy: call.policy,
        decision: result.decision,
        ...(result.reason ? { reason: result.reason } : {}),
      },
      parentEventId: evaluated.id,
      severity: result.decision === "allow" ? "info" : "warn",
    });
    return {
      policy: call.policy,
      decision: result.decision,
      reason: result.reason,
      details: result.details,
      eventId: evaluated.id,
    };
  }

  // ---- approvals ------------------------------------------------------------

  async requestApproval(request: ApprovalRequest): Promise<ApprovalResolution> {
    const served = this.serve("human.approval_requested", "approval", undefined);
    if (served) {
      const requested = served.event.output as JsonObject;
      const resolved = served.children.find((c) => c.eventType === "human.approval_resolved");
      const approvalId = String(requested.approvalId ?? "");
      if (resolved) {
        const payload = resolved.output as JsonObject;
        return { approvalId, decision: payload.decision as ApprovalResolution["decision"] };
      }
      return { approvalId, decision: "pending" };
    }
    const started = this.clock.now();
    const ctx = { context: this.store.getContext(), state: this.store.getState(), now: started };
    const resolution: ApprovalResolution & { latencyMs?: number } = this.adapters.approvals
      ? await this.adapters.approvals.request(request, ctx)
      : { approvalId: this.log.newSpanId().replace("spn_", "apr_"), decision: "pending" };
    const requested = this.emit({
      eventType: "human.approval_requested",
      name: "approval",
      input: toJson(request),
      output: {
        approvalId: resolution.approvalId,
        reason: request.reason,
        status: resolution.decision,
        ...(request.request !== undefined ? { request: request.request } : {}),
      },
      severity: "warn",
    });
    if (resolution.decision !== "pending") {
      this.clock.advance(resolution.latencyMs ?? 0);
      this.emit({
        eventType: "human.approval_resolved",
        name: "approval",
        output: { approvalId: resolution.approvalId, decision: resolution.decision },
        parentEventId: requested.id,
        durationMs: this.clock.now() - started,
      });
    }
    return { approvalId: resolution.approvalId, decision: resolution.decision };
  }
}

function outcomeEventType(decision: PolicyDecision): string {
  switch (decision) {
    case "allow":
      return "policy.allowed";
    case "deny":
      return "policy.denied";
    case "approval_required":
      return "policy.approval_required";
  }
}

function normaliseToolResult(raw: ToolResult | JsonValue): ToolResult {
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw) && "result" in raw) {
    const r = raw as ToolResult;
    return { result: r.result, latencyMs: r.latencyMs, estimatedCost: r.estimatedCost };
  }
  return { result: raw as JsonValue };
}

function wrapError(error: unknown): ToolExecutionError {
  if (error instanceof Error) {
    const maybe = error as Error & { code?: unknown; retryable?: unknown };
    return new ToolExecutionError(error.message, {
      code: typeof maybe.code === "string" ? maybe.code : undefined,
      retryable: typeof maybe.retryable === "boolean" ? maybe.retryable : undefined,
      cause: error,
    });
  }
  return new ToolExecutionError(String(error));
}

function extractLatency(error: unknown): number {
  const maybe = error as { latencyMs?: unknown } | null;
  return maybe && typeof maybe.latencyMs === "number" && maybe.latencyMs >= 0 ? maybe.latencyMs : 0;
}

/**
 * Marks a tool response/error produced by an override. The event keeps the
 * replay origin (it is part of the execution) but records which override
 * shaped it, so the comparison view can highlight it.
 */
function overrideMetadata(override: Override): JsonObject {
  return {
    shadow: {
      overrideApplied: true,
      overrideKind: override.kind,
      ...(override.id ? { overrideId: override.id } : {}),
    },
  };
}

function isObj(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
