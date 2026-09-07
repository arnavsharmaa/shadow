import type {
  Branch,
  Fork,
  JsonObject,
  JsonValue,
  Outcome,
  ReplayMode,
  ShadowEvent,
} from "@shadow/schemas";
import { VirtualClock, type Clock } from "../clock.js";
import { seededIdGenerator, type IdGenerator } from "../ids.js";
import { deepEqual, toJson } from "../json.js";
import { aggregateMetrics } from "../metrics/aggregate.js";
import { defaultPricingProvider } from "../metrics/pricing.js";
import { diffJson } from "../state/diff.js";
import { reconstructState } from "../state/reconstruct.js";
import { InMemoryStateStore } from "../state/store.js";
import { EventLog } from "./event-log.js";
import { HistoryCursor } from "./history.js";
import { RuntimeHost } from "./host.js";
import { errorToJson, runProgramLifecycle } from "./run.js";
import { ReplayHistoryMismatchError, type AgentDefinition } from "./types.js";

export interface ReplayPlan {
  replayId: string;
  mode: ReplayMode;
  trace: { id: string };
  branch: Branch;
  fork: Fork;
  /** Effective lineage of the *parent* branch. */
  parentLineage: readonly ShadowEvent[];
  /** Events already stored on the child branch (normally just `fork.created`). */
  existingBranchEvents: readonly ShadowEvent[];
  /** Overrides inherited from ancestor forks (policy overrides are honoured). */
  inheritedOverrides?: Fork["overrides"];
}

export interface CreateReplayOptions {
  mode?: ReplayMode;
  ids?: IdGenerator;
  replayId?: string;
}

export interface ReplayOutcome {
  replayId: string;
  status: "completed" | "failed";
  /** Newly produced events for the child branch (excluding pre-existing ones). */
  events: ShadowEvent[];
  outcome: Outcome | null;
  error: string | null;
  metrics: ReturnType<typeof aggregateMetrics>;
  branchStatus: Branch["status"];
}

export class ReplayError extends Error {
  constructor(
    message: string,
    readonly code: "no_program" | "history_mismatch" | "unsupported_mode" | "invalid_plan",
    readonly details: JsonObject = {},
  ) {
    super(message);
    this.name = "ReplayError";
  }
}

/** Build a replay plan for a forked branch. */
export function createReplay(
  input: Omit<ReplayPlan, "replayId" | "mode"> & CreateReplayOptions,
): ReplayPlan {
  const ids = input.ids ?? seededIdGenerator(`${input.branch.id}:replay`);
  const mode = input.mode ?? "deterministic";
  if (mode === "historical") {
    throw new ReplayError(
      "historical replay does not execute anything; read the recorded events instead",
      "unsupported_mode",
    );
  }
  if (input.branch.parentBranchId === null || input.branch.forkSequence === null) {
    throw new ReplayError("only forked branches can be replayed", "invalid_plan");
  }
  return {
    replayId: input.replayId ?? ids.next("rpl"),
    mode,
    trace: input.trace,
    branch: input.branch,
    fork: input.fork,
    parentLineage: input.parentLineage,
    existingBranchEvents: input.existingBranchEvents,
    inheritedOverrides: input.inheritedOverrides ?? [],
  };
}

/** Extract the original agent input from the lineage's `agent.started` event. */
export function findAgentInput(lineage: readonly ShadowEvent[]): JsonValue {
  const started = lineage.find((e) => e.eventType === "agent.started");
  const input = started?.input;
  if (input && typeof input === "object" && !Array.isArray(input) && "request" in input) {
    return (input as JsonObject).request as JsonValue;
  }
  return input ?? null;
}

/**
 * Execute a replay plan: serve the recorded prefix to the program, verify the
 * state at the fork point, apply overrides, then continue deterministically.
 */
export async function executeReplay(
  plan: ReplayPlan,
  definition: AgentDefinition,
  options: { clock?: Clock; ids?: IdGenerator; sink?: (event: ShadowEvent) => void } = {},
): Promise<ReplayOutcome> {
  const forkSequence = plan.branch.forkSequence as number;
  const history = plan.parentLineage.filter((e) => e.sequence <= forkSequence);
  const forkEvent = plan.parentLineage.find((e) => e.id === plan.fork.forkEventId);
  const startAt =
    forkEvent?.timestamp ?? history[history.length - 1]?.timestamp ?? new Date(0).toISOString();
  const clock = options.clock ?? new VirtualClock(startAt);
  const ids = options.ids ?? seededIdGenerator(`${plan.branch.id}:${plan.replayId}`);
  const startSequence = Math.max(
    forkSequence + 1,
    ...plan.existingBranchEvents.map((e) => e.sequence + 1),
  );

  const log = new EventLog({
    traceId: plan.trace.id,
    branchId: plan.branch.id,
    ids,
    clock,
    source: "replay",
    startSequence,
    baseMetadata: {
      shadow: {
        origin: "replay",
        replayId: plan.replayId,
        forkId: plan.fork.id,
        scenario: definition.slug,
      },
    },
    sink: options.sink,
  });

  const allOverrides = [
    ...(plan.inheritedOverrides ?? []).filter((o) => o.kind === "policy"),
    ...plan.fork.overrides,
  ];
  const expectedAtFork = reconstructState(history);
  const store = new InMemoryStateStore();

  const host = new RuntimeHost({
    traceId: plan.trace.id,
    branchId: plan.branch.id,
    mode: "replay",
    log,
    store,
    clock,
    adapters: definition.createAdapters({ seed: plan.trace.id }),
    execution: plan.mode === "live" ? "callbacks" : "adapters",
    pricing: definition.pricing ?? defaultPricingProvider,
    snapshotPolicy: definition.snapshotPolicy,
    policyConfig: definition.policyConfig,
    history: new HistoryCursor(history),
    overrides: allOverrides,
    onLive: (h) => {
      // The program replayed the recorded prefix; its state must match the
      // reconstruction or the program is not deterministic.
      const state = store.getState();
      const context = store.getContext();
      if (!deepEqual(state, expectedAtFork.state) || !deepEqual(context, expectedAtFork.context)) {
        throw new ReplayHistoryMismatchError(
          "program state at the fork point differs from the recorded state",
          {
            stateDiff: diffJson(expectedAtFork.state, state),
            contextDiff: diffJson(expectedAtFork.context, context),
          },
        );
      }
      h.applyStateOverrides(plan.fork.overrides, { shadow: { forkId: plan.fork.id } });
    },
  });

  log.emit({
    eventType: "replay.started",
    name: plan.mode,
    input: { mode: plan.mode, forkId: plan.fork.id, forkSequence, overrides: plan.fork.overrides },
    metadata: { shadow: { origin: "replay" } },
  });

  const input = findAgentInput(plan.parentLineage);
  const replayStartedAt = clock.now();
  try {
    const result = await runProgramLifecycle(host, definition, input, log);
    log.emit({
      eventType: "replay.completed",
      name: plan.mode,
      output: toJson({
        status: result.status,
        outcome: result.outcome,
        eventCount: log.events.length + 1,
      }),
      durationMs: clock.now() - replayStartedAt,
    });
    return {
      replayId: plan.replayId,
      status: "completed",
      events: log.events,
      outcome: result.outcome,
      error: null,
      metrics: aggregateMetrics([...history, ...plan.existingBranchEvents, ...log.events]),
      branchStatus: result.status === "failed" ? "failed" : "completed",
    };
  } catch (error) {
    const isMismatch = error instanceof ReplayHistoryMismatchError;
    const message = error instanceof Error ? error.message : String(error);
    log.emit({
      eventType: "replay.failed",
      name: plan.mode,
      output: { error: errorToJson(error), ...(isMismatch ? { details: error.details } : {}) },
      severity: "error",
      durationMs: clock.now() - replayStartedAt,
    });
    return {
      replayId: plan.replayId,
      status: "failed",
      events: log.events,
      outcome: null,
      error: isMismatch ? `replay could not reproduce the recorded prefix: ${message}` : message,
      metrics: aggregateMetrics([...history, ...plan.existingBranchEvents, ...log.events]),
      branchStatus: "failed",
    };
  }
}
