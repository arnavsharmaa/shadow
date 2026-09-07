import type { JsonObject, ReconstructedState, ShadowEvent } from "@shadow/schemas";
import {
  contextAddedPayloadSchema,
  contextRemovedPayloadSchema,
  statePatchPayloadSchema,
  stateSnapshotPayloadSchema,
} from "@shadow/schemas";
import { deepClone } from "../json.js";
import { applyPatch } from "./patch.js";

export interface SnapshotPolicy {
  /** Take a full snapshot every N state/context mutations. */
  everyMutations: number;
}

export const DEFAULT_SNAPSHOT_POLICY: SnapshotPolicy = { everyMutations: 25 };

export interface ReconstructOptions {
  /** Reconstruct state after this sequence (inclusive). Default: last event. */
  upToSequence?: number;
  /** Reconstruct state after this event (inclusive). */
  upToEventId?: string;
  /** When true (default) reconstruct from the latest snapshot ≤ target. */
  useSnapshots?: boolean;
}

export class StateReconstructionError extends Error {
  constructor(
    message: string,
    readonly eventId?: string,
  ) {
    super(message);
    this.name = "StateReconstructionError";
  }
}

/**
 * Rebuild the agent's state and context as it was right after the target
 * event. Events must be the branch's *effective* lineage sorted by sequence.
 */
export function reconstructState(
  events: readonly ShadowEvent[],
  options: ReconstructOptions = {},
): ReconstructedState {
  let target = options.upToSequence ?? Number.POSITIVE_INFINITY;
  if (options.upToEventId !== undefined) {
    const found = events.find((e) => e.id === options.upToEventId);
    if (!found)
      throw new StateReconstructionError(
        `event ${options.upToEventId} not in lineage`,
        options.upToEventId,
      );
    target = found.sequence;
  }
  const useSnapshots = options.useSnapshots ?? true;

  // Find the latest snapshot at or before the target.
  let startIndex = 0;
  let state: JsonObject = {};
  let context: JsonObject = {};
  let stateVersion = 0;
  let fromSnapshotSequence: number | null = null;
  if (useSnapshots) {
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i] as ShadowEvent;
      if (event.sequence > target) continue;
      if (event.eventType === "state.snapshot") {
        const payload = stateSnapshotPayloadSchema.safeParse(event.output);
        if (!payload.success) {
          throw new StateReconstructionError(
            `invalid state.snapshot payload on ${event.id}`,
            event.id,
          );
        }
        state = deepClone(payload.data.state);
        context = deepClone(payload.data.context);
        stateVersion = event.stateVersion ?? stateVersion;
        fromSnapshotSequence = event.sequence;
        startIndex = i + 1;
        break;
      }
    }
  }

  let applied = 0;
  let asOfSequence = fromSnapshotSequence ?? -1;
  for (let i = startIndex; i < events.length; i++) {
    const event = events[i] as ShadowEvent;
    if (event.sequence > target) break;
    asOfSequence = event.sequence;
    switch (event.eventType) {
      case "state.snapshot": {
        const payload = stateSnapshotPayloadSchema.safeParse(event.output);
        if (!payload.success)
          throw new StateReconstructionError(
            `invalid state.snapshot payload on ${event.id}`,
            event.id,
          );
        state = deepClone(payload.data.state);
        context = deepClone(payload.data.context);
        stateVersion = event.stateVersion ?? stateVersion + 1;
        applied++;
        break;
      }
      case "state.patch": {
        const payload = statePatchPayloadSchema.safeParse(event.output);
        if (!payload.success)
          throw new StateReconstructionError(
            `invalid state.patch payload on ${event.id}`,
            event.id,
          );
        const next = applyPatch(state, payload.data.ops);
        state = (
          next !== null && typeof next === "object" && !Array.isArray(next) ? next : {}
        ) as JsonObject;
        stateVersion = event.stateVersion ?? stateVersion + 1;
        applied++;
        break;
      }
      case "context.added": {
        const payload = contextAddedPayloadSchema.safeParse(event.output);
        if (!payload.success)
          throw new StateReconstructionError(
            `invalid context.added payload on ${event.id}`,
            event.id,
          );
        context = { ...context, [payload.data.key]: payload.data.value };
        stateVersion = event.stateVersion ?? stateVersion + 1;
        applied++;
        break;
      }
      case "context.removed": {
        const payload = contextRemovedPayloadSchema.safeParse(event.output);
        if (!payload.success)
          throw new StateReconstructionError(
            `invalid context.removed payload on ${event.id}`,
            event.id,
          );
        const { [payload.data.key]: _removed, ...rest } = context;
        context = rest;
        stateVersion = event.stateVersion ?? stateVersion + 1;
        applied++;
        break;
      }
      default:
        break;
    }
  }

  return {
    state,
    context,
    stateVersion,
    asOfSequence,
    fromSnapshotSequence,
    appliedEvents: applied,
  };
}

/** State before and after a given event, for inspectors. */
export function stateAround(events: readonly ShadowEvent[], eventId: string) {
  const index = events.findIndex((e) => e.id === eventId);
  if (index === -1) throw new StateReconstructionError(`event ${eventId} not in lineage`, eventId);
  const event = events[index] as ShadowEvent;
  const before = reconstructState(events, { upToSequence: event.sequence - 1 });
  const after = reconstructState(events, { upToSequence: event.sequence });
  return { before, after };
}

/** Event types that mutate reconstructed state. */
export const STATE_MUTATING_EVENT_TYPES = new Set([
  "state.snapshot",
  "state.patch",
  "context.added",
  "context.removed",
]);
