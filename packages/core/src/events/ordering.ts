import type { ShadowEvent } from "@shadow/schemas";

export class EventOrderingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventOrderingError";
  }
}

/** Sort by sequence, then timestamp, then id (stable and total). */
export function sortEvents<T extends Pick<ShadowEvent, "sequence" | "timestamp" | "id">>(
  events: readonly T[],
): T[] {
  return [...events].sort((a, b) => {
    if (a.sequence !== b.sequence) return a.sequence - b.sequence;
    if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Throws when sequences repeat or go backwards within a branch. */
export function assertStrictlyIncreasing(events: readonly ShadowEvent[]): void {
  let previous = -1;
  for (const event of events) {
    if (event.sequence <= previous) {
      throw new EventOrderingError(
        `event ${event.id} has sequence ${event.sequence} but previous sequence was ${previous}`,
      );
    }
    previous = event.sequence;
  }
}

export function nextSequence(events: readonly Pick<ShadowEvent, "sequence">[]): number {
  let max = -1;
  for (const event of events) if (event.sequence > max) max = event.sequence;
  return max + 1;
}

/** First event matching a predicate (events are assumed sorted). */
export function findFirst(events: readonly ShadowEvent[], predicate: (e: ShadowEvent) => boolean) {
  for (const event of events) if (predicate(event)) return event;
  return undefined;
}

export const isErrorEvent = (e: ShadowEvent) =>
  e.severity === "error" || e.eventType === "tool.error" || e.eventType === "trace.failed";

export const isPolicyViolationEvent = (e: ShadowEvent) =>
  e.eventType === "policy.denied" || e.eventType === "policy.approval_required";
