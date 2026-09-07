import type { JsonObject, JsonValue, ShadowEvent } from "@shadow/schemas";
import { deepEqual } from "../json.js";
import { ReplayHistoryMismatchError } from "./types.js";

/** Event types that correspond one-to-one with program operations. */
export const OP_EVENT_TYPES = new Set([
  "tool.request",
  "model.request",
  "policy.evaluated",
  "human.approval_requested",
  "context.added",
  "context.removed",
  "state.patch",
  "state.snapshot",
  "agent.note",
]);

export function shadowMeta(event: ShadowEvent): JsonObject {
  const s = event.metadata.shadow;
  return typeof s === "object" && s !== null && !Array.isArray(s) ? s : {};
}

export function isOverrideOrigin(event: ShadowEvent): boolean {
  return shadowMeta(event).origin === "override";
}

export function isSetupEvent(event: ShadowEvent): boolean {
  return (
    event.eventType === "fork.created" ||
    event.eventType.startsWith("replay.") ||
    isOverrideOrigin(event)
  );
}

function isAutoSnapshot(event: ShadowEvent): boolean {
  return event.eventType === "state.snapshot" && event.metadata.auto === true;
}

/**
 * A guard evaluation is nested under the tool request that triggered it and
 * is served together with that request, so it is not a separate program op.
 */
function isGuardEvaluation(event: ShadowEvent): boolean {
  return event.eventType === "policy.evaluated" && event.parentEventId !== null;
}

/** True when the program itself produced this event (so replay must match it). */
export function isProgramOp(event: ShadowEvent): boolean {
  if (!OP_EVENT_TYPES.has(event.eventType)) return false;
  if (isSetupEvent(event)) return false;
  if (isAutoSnapshot(event)) return false;
  if (isGuardEvaluation(event)) return false;
  return true;
}

export interface ServedOp {
  event: ShadowEvent;
  /** Direct children (responses, errors, policy outcomes) of the op event. */
  children: ShadowEvent[];
  /** Events skipped while seeking, in order. */
  skipped: ShadowEvent[];
}

/**
 * Cursor over the recorded prefix of a lineage. Each program operation is
 * matched, in order, against the next recorded operation. Mismatches signal
 * non-determinism and abort the replay with a precise error.
 */
export class HistoryCursor {
  private index = 0;
  private readonly childrenByParent = new Map<string, ShadowEvent[]>();

  constructor(private readonly events: readonly ShadowEvent[]) {
    for (const event of events) {
      if (event.parentEventId) {
        const list = this.childrenByParent.get(event.parentEventId) ?? [];
        list.push(event);
        this.childrenByParent.set(event.parentEventId, list);
      }
    }
  }

  /** True when no program operation remains in the recorded prefix. */
  get exhausted(): boolean {
    for (let i = this.index; i < this.events.length; i++) {
      if (isProgramOp(this.events[i] as ShadowEvent)) return false;
    }
    return true;
  }

  /** Remaining events that were never consumed (for state replay of overrides). */
  drain(): ShadowEvent[] {
    const rest = this.events.slice(this.index);
    this.index = this.events.length;
    return rest;
  }

  /**
   * Serve the next recorded operation, asserting it matches the requested
   * type/name. Returns null when the prefix is exhausted (replay goes live).
   */
  serve(eventType: string, name: string, input?: JsonValue): ServedOp | null {
    const skipped: ShadowEvent[] = [];
    while (this.index < this.events.length) {
      const event = this.events[this.index] as ShadowEvent;
      if (!isProgramOp(event)) {
        skipped.push(event);
        this.index++;
        continue;
      }
      if (event.eventType !== eventType || event.name !== name) {
        throw new ReplayHistoryMismatchError(
          `replay expected recorded ${event.eventType} '${event.name}' (sequence ${event.sequence}) but the program performed ${eventType} '${name}'`,
          {
            expectedType: event.eventType,
            expectedName: event.name,
            actualType: eventType,
            actualName: name,
            sequence: event.sequence,
            eventId: event.id,
          },
        );
      }
      if (input !== undefined && event.input !== undefined && !deepEqual(event.input, input)) {
        throw new ReplayHistoryMismatchError(
          `replay input for ${eventType} '${name}' (sequence ${event.sequence}) differs from the recorded input`,
          { sequence: event.sequence, eventId: event.id, recorded: event.input, actual: input },
        );
      }
      this.index++;
      return { event, children: this.childrenByParent.get(event.id) ?? [], skipped };
    }
    // Put skipped events back so callers can still drain them.
    this.index -= skipped.length;
    return null;
  }
}
