import { describe, expect, it } from "vitest";
import {
  EventOrderingError,
  assertStrictlyIncreasing,
  findFirst,
  isErrorEvent,
  isPolicyViolationEvent,
  nextSequence,
  sortEvents,
} from "../src/index.js";
import { makeEvent } from "./helpers.js";

describe("sortEvents", () => {
  it("orders by sequence, then timestamp, then id and does not mutate the input", () => {
    const events = [
      makeEvent({ sequence: 2, id: "evt_b", timestamp: "2026-01-01T00:00:02.000Z" }),
      makeEvent({ sequence: 1, id: "evt_z", timestamp: "2026-01-01T00:00:05.000Z" }),
      makeEvent({ sequence: 1, id: "evt_y", timestamp: "2026-01-01T00:00:01.000Z" }),
      makeEvent({ sequence: 1, id: "evt_a", timestamp: "2026-01-01T00:00:01.000Z" }),
      makeEvent({ sequence: 0, id: "evt_c", timestamp: "2026-01-01T00:00:09.000Z" }),
    ];
    const copy = [...events];
    const sorted = sortEvents(events);
    expect(sorted.map((e) => e.id)).toEqual(["evt_c", "evt_a", "evt_y", "evt_z", "evt_b"]);
    expect(events).toEqual(copy);
  });

  it("is a total order: sorting any permutation yields the same result", () => {
    const base = [
      makeEvent({ sequence: 3, id: "evt_1" }),
      makeEvent({ sequence: 3, id: "evt_0" }),
      makeEvent({ sequence: 0, id: "evt_5" }),
      makeEvent({ sequence: 1, id: "evt_3", timestamp: "2026-01-01T00:00:00.000Z" }),
      makeEvent({ sequence: 1, id: "evt_3b", timestamp: "2026-01-01T00:00:00.000Z" }),
    ];
    const expected = sortEvents(base).map((e) => e.id);
    expect(sortEvents([...base].reverse()).map((e) => e.id)).toEqual(expected);
    expect(
      sortEvents(
        [base[2], base[4], base[0], base[3], base[1]].map((e) => e as NonNullable<typeof e>),
      ).map((e) => e.id),
    ).toEqual(expected);
  });

  it("accepts minimal event-like objects", () => {
    const sorted = sortEvents([
      { sequence: 1, timestamp: "b", id: "x" },
      { sequence: 0, timestamp: "a", id: "y" },
    ]);
    expect(sorted.map((e) => e.id)).toEqual(["y", "x"]);
  });
});

describe("assertStrictlyIncreasing", () => {
  it("accepts strictly increasing sequences (gaps allowed)", () => {
    expect(() =>
      assertStrictlyIncreasing([
        makeEvent({ sequence: 0 }),
        makeEvent({ sequence: 2 }),
        makeEvent({ sequence: 7 }),
      ]),
    ).not.toThrow();
    expect(() => assertStrictlyIncreasing([])).not.toThrow();
  });

  it("rejects repeated or decreasing sequences with a descriptive error", () => {
    const repeated = [
      makeEvent({ sequence: 1, id: "evt_a" }),
      makeEvent({ sequence: 1, id: "evt_b" }),
    ];
    expect(() => assertStrictlyIncreasing(repeated)).toThrow(EventOrderingError);
    expect(() => assertStrictlyIncreasing(repeated)).toThrow(
      /evt_b has sequence 1 but previous sequence was 1/,
    );
    const decreasing = [makeEvent({ sequence: 5 }), makeEvent({ sequence: 4 })];
    expect(() => assertStrictlyIncreasing(decreasing)).toThrow(EventOrderingError);
  });
});

describe("nextSequence", () => {
  it("returns 0 for an empty list and max + 1 otherwise, regardless of order", () => {
    expect(nextSequence([])).toBe(0);
    expect(nextSequence([{ sequence: 4 }, { sequence: 9 }, { sequence: 2 }])).toBe(10);
  });
});

describe("findFirst", () => {
  it("returns the first matching event or undefined", () => {
    const events = [
      makeEvent({ sequence: 0, name: "a" }),
      makeEvent({ sequence: 1, name: "b" }),
      makeEvent({ sequence: 2, name: "b" }),
    ];
    expect(findFirst(events, (e) => e.name === "b")?.sequence).toBe(1);
    expect(findFirst(events, (e) => e.name === "zzz")).toBeUndefined();
  });
});

describe("isErrorEvent / isPolicyViolationEvent", () => {
  it("classifies error severity, tool errors and failed traces as errors", () => {
    expect(isErrorEvent(makeEvent({ sequence: 0, severity: "error" }))).toBe(true);
    expect(
      isErrorEvent(makeEvent({ sequence: 0, eventType: "tool.error", severity: "warn" })),
    ).toBe(true);
    expect(isErrorEvent(makeEvent({ sequence: 0, eventType: "trace.failed" }))).toBe(true);
    expect(
      isErrorEvent(makeEvent({ sequence: 0, eventType: "tool.response", severity: "warn" })),
    ).toBe(false);
  });

  it("recognises policy denials and approval requirements", () => {
    expect(isPolicyViolationEvent(makeEvent({ sequence: 0, eventType: "policy.denied" }))).toBe(
      true,
    );
    expect(
      isPolicyViolationEvent(makeEvent({ sequence: 0, eventType: "policy.approval_required" })),
    ).toBe(true);
    expect(isPolicyViolationEvent(makeEvent({ sequence: 0, eventType: "policy.allowed" }))).toBe(
      false,
    );
    expect(isPolicyViolationEvent(makeEvent({ sequence: 0, eventType: "policy.evaluated" }))).toBe(
      false,
    );
  });
});
