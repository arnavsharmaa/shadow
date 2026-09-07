import type { Branch, Fork, JsonObject, Override, ShadowEvent, Trace } from "@shadow/schemas";
import { emptyBranchMetrics } from "@shadow/schemas";
import { isoTimestamp, type Clock } from "../clock.js";
import type { IdGenerator } from "../ids.js";
import { isSetupEvent } from "../runtime/history.js";
import { defaultBranchName } from "./lineage.js";

export class ForkError extends Error {
  constructor(
    message: string,
    readonly code: "event_not_found" | "not_forkable" = "not_forkable",
  ) {
    super(message);
    this.name = "ForkError";
  }
}

/** Events that close an operation and therefore fork at their opener. */
const CLOSER_TYPES = new Set([
  "tool.response",
  "tool.error",
  "model.response",
  "policy.allowed",
  "policy.denied",
  "policy.approval_required",
  "human.approval_resolved",
]);

export interface ForkPoint {
  /** First event that is re-executed on the new branch. */
  forkEvent: ShadowEvent;
  /** Sequence of the last event inherited from the parent lineage. */
  forkSequence: number;
  /** The event the user selected (may differ from forkEvent after normalisation). */
  selectedEvent: ShadowEvent;
}

/**
 * Normalise the selected event to an operation boundary. Selecting a
 * response forks at its request; policy outcomes fork at the evaluation (or
 * the guarded tool request that contains it).
 */
export function resolveForkPoint(lineage: readonly ShadowEvent[], eventId: string): ForkPoint {
  const byId = new Map(lineage.map((e) => [e.id, e]));
  const selected = byId.get(eventId);
  if (!selected) {
    throw new ForkError(`event ${eventId} is not part of this branch lineage`, "event_not_found");
  }
  let current = selected;
  if (isSetupEvent(current)) {
    throw new ForkError(`cannot fork from ${current.eventType} (replay bookkeeping event)`);
  }
  // Walk up parentEventId links while we sit on a closer or a nested op.
  for (let i = 0; i < 8; i++) {
    const parent = current.parentEventId ? byId.get(current.parentEventId) : undefined;
    if (!parent) break;
    if (CLOSER_TYPES.has(current.eventType) || parent.eventType === "tool.request")
      current = parent;
    else break;
  }
  return { forkEvent: current, forkSequence: current.sequence - 1, selectedEvent: selected };
}

export interface CreateForkOptions {
  trace: Pick<Trace, "id">;
  parentBranch: Branch;
  /** Effective lineage of the parent branch. */
  lineage: readonly ShadowEvent[];
  existingBranches: readonly Branch[];
  forkEventId: string;
  overrides: Override[];
  name?: string;
  metadata?: JsonObject;
  ids: IdGenerator;
  clock: Clock;
}

export interface CreateForkResult {
  branch: Branch;
  fork: Fork;
  forkPoint: ForkPoint;
  /** The `fork.created` event, first event of the child branch. */
  events: ShadowEvent[];
}

/** Create a child branch (pending replay) with its persisted fork definition. */
export function createFork(options: CreateForkOptions): CreateForkResult {
  const forkPoint = resolveForkPoint(options.lineage, options.forkEventId);
  const now = isoTimestamp(options.clock.now());
  const branchId = options.ids.next("br");
  const forkId = options.ids.next("frk");
  const name = options.name?.trim() || defaultBranchName(options.existingBranches);
  const overrides = options.overrides.map((o, i) => ({ ...o, id: o.id ?? `ovr_${i + 1}` }));

  const branch: Branch = {
    id: branchId,
    traceId: options.trace.id,
    name,
    parentBranchId: options.parentBranch.id,
    forkId,
    forkEventId: forkPoint.forkEvent.id,
    forkSequence: forkPoint.forkSequence,
    depth: options.parentBranch.depth + 1,
    status: "pending",
    outcome: null,
    metrics: emptyBranchMetrics(),
    createdAt: now,
    updatedAt: now,
    metadata: options.metadata ?? {},
  };
  const fork: Fork = {
    id: forkId,
    traceId: options.trace.id,
    parentBranchId: options.parentBranch.id,
    childBranchId: branchId,
    forkEventId: forkPoint.forkEvent.id,
    forkSequence: forkPoint.forkSequence,
    overrides,
    createdAt: now,
    metadata: { selectedEventId: forkPoint.selectedEvent.id },
  };
  const forkEvent: ShadowEvent = {
    id: options.ids.next("evt"),
    schemaVersion: forkPoint.forkEvent.schemaVersion,
    traceId: options.trace.id,
    branchId,
    parentEventId: null,
    spanId: null,
    parentSpanId: null,
    sequence: forkPoint.forkSequence + 1,
    timestamp: forkPoint.forkEvent.timestamp,
    durationMs: null,
    eventType: "fork.created",
    source: "api",
    severity: "info",
    name,
    input: {
      parentBranchId: options.parentBranch.id,
      forkEventId: forkPoint.forkEvent.id,
      forkSequence: forkPoint.forkSequence,
    },
    output: { overrides },
    metadata: { shadow: { origin: "replay", forkId } },
    tags: ["fork"],
    tokenUsage: null,
    estimatedCost: null,
    stateVersion: null,
    correlationId: null,
  };
  return { branch, fork, forkPoint, events: [forkEvent] };
}
