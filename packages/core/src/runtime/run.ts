import type { AgentProgram, JsonObject, JsonValue, Outcome, ShadowEvent } from "@shadow/schemas";
import { systemClock, VirtualClock, type Clock } from "../clock.js";
import { randomIdGenerator, seededIdGenerator, type IdGenerator } from "../ids.js";
import { toJson } from "../json.js";
import { aggregateMetrics } from "../metrics/aggregate.js";
import { defaultPricingProvider } from "../metrics/pricing.js";
import { InMemoryStateStore } from "../state/store.js";
import { EventLog } from "./event-log.js";
import { RuntimeHost } from "./host.js";
import { ReplayHistoryMismatchError, type AgentDefinition } from "./types.js";

export interface RecordOptions<Input extends JsonValue> {
  definition: AgentDefinition<Input>;
  input: Input;
  traceId: string;
  branchId: string;
  traceName: string;
  /** Deterministic seed for ids and adapters; omit for random ids. */
  seed?: string;
  /** Start time for a virtual clock; omit to use wall-clock time. */
  startAt?: string | number;
  clock?: Clock;
  ids?: IdGenerator;
  traceMetadata?: JsonObject;
  tags?: string[];
  source?: string;
  sink?: (event: ShadowEvent) => void;
}

export interface RecordResult {
  events: ShadowEvent[];
  outcome: Outcome | null;
  status: "completed" | "failed";
  error: Error | null;
  metrics: ReturnType<typeof aggregateMetrics>;
}

export function normaliseOutcome(value: Outcome | void | undefined, fallback: Outcome): Outcome {
  if (!value) return fallback;
  return toJson(value) as Outcome;
}

export function errorToJson(error: unknown): JsonObject {
  if (error instanceof Error) {
    const e = error as Error & { code?: unknown };
    return {
      message: error.message,
      name: error.name,
      ...(typeof e.code === "string" ? { code: e.code } : {}),
    };
  }
  return { message: String(error) };
}

/**
 * Execute an agent program from the start, recording a complete root-branch
 * trace. With a `seed` and `startAt` the resulting events are fully
 * deterministic (used by seeds, examples and tests).
 */
export async function recordExecution<Input extends JsonValue>(
  options: RecordOptions<Input>,
): Promise<RecordResult> {
  const seed = options.seed;
  const ids = options.ids ?? (seed ? seededIdGenerator(seed) : randomIdGenerator());
  const clock =
    options.clock ??
    (options.startAt !== undefined ? new VirtualClock(options.startAt) : systemClock);
  const log = new EventLog({
    traceId: options.traceId,
    branchId: options.branchId,
    ids,
    clock,
    source: options.source ?? "sdk",
    baseMetadata: { shadow: { origin: "recorded", scenario: options.definition.slug } },
    sink: options.sink,
  });
  const host = new RuntimeHost({
    traceId: options.traceId,
    branchId: options.branchId,
    mode: "record",
    log,
    store: new InMemoryStateStore(),
    clock,
    adapters: options.definition.createAdapters({ seed: seed ?? options.traceId }),
    execution: "callbacks",
    pricing: options.definition.pricing ?? defaultPricingProvider,
    snapshotPolicy: options.definition.snapshotPolicy,
    policyConfig: options.definition.policyConfig,
  });

  host.emit({
    eventType: "trace.started",
    name: options.traceName,
    input: { name: options.traceName, metadata: options.traceMetadata ?? {} },
    tags: options.tags,
  });
  const result = await runProgramLifecycle(host, options.definition, options.input, log);
  return { ...result, events: log.events, metrics: aggregateMetrics(log.events) };
}

function isViolation(outcome: Outcome | null): boolean {
  return outcome?.kind === "policy_violation";
}

/**
 * Run the agent span and the trace completion events. Shared by recording and
 * replay: the replay engine calls this after the history prefix is set up.
 */
export async function runProgramLifecycle<Input extends JsonValue>(
  host: RuntimeHost,
  definition: Pick<AgentDefinition<Input>, "slug" | "name" | "program">,
  input: Input,
  log: EventLog,
): Promise<Pick<RecordResult, "outcome" | "status" | "error">> {
  const agentSpan = log.newSpanId();
  const started = host.now;
  let outcome: Outcome | null = null;
  let error: Error | null = null;
  const program = definition.program as AgentProgram<Input>;
  await host.withSpan(agentSpan, async () => {
    // agent.started is only emitted live; in replay it is part of the inherited prefix.
    if (host.isLive) {
      host.emit({
        eventType: "agent.started",
        name: definition.name,
        input: { agent: definition.slug, request: input },
        spanId: agentSpan,
        parentSpanId: null,
      });
    }
    try {
      outcome = normaliseOutcome(await program(host, input), {
        kind: "completed",
        label: "Completed",
      });
    } catch (caught) {
      // A history mismatch means the replay could not reproduce the recorded
      // prefix; it is a replay failure, not a program failure, so let the
      // replay engine record it as `replay.failed`.
      if (caught instanceof ReplayHistoryMismatchError) throw caught;
      error = caught instanceof Error ? caught : new Error(String(caught));
    }
    host.goLive();
    host.emit({
      eventType: "agent.completed",
      name: definition.name,
      output: error ? { error: errorToJson(error) } : toJson({ outcome }),
      spanId: agentSpan,
      parentSpanId: null,
      durationMs: host.now - started,
      severity: error ? "error" : "info",
    });
  });
  if (error) {
    const failed = error as Error;
    const failedOutcome: Outcome = { kind: "error", label: `Failed: ${failed.message}` };
    host.emit({
      eventType: "trace.failed",
      name: "trace.failed",
      output: toJson({ error: errorToJson(failed), outcome: failedOutcome }),
      severity: "error",
    });
    return { outcome: failedOutcome, status: "failed", error: failed };
  }
  const finalOutcome = outcome as Outcome | null;
  const violation = isViolation(finalOutcome);
  host.emit({
    eventType: violation ? "trace.failed" : "trace.completed",
    name: violation ? "trace.failed" : "trace.completed",
    output: toJson({ outcome: finalOutcome }),
    severity: violation ? "error" : "info",
  });
  return { outcome: finalOutcome, status: violation ? "failed" : "completed", error: null };
}
