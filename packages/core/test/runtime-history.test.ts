import type { ShadowEvent } from "@shadow/schemas";
import { describe, expect, it } from "vitest";
import {
  HistoryCursor,
  OP_EVENT_TYPES,
  ReplayHistoryMismatchError,
  isOverrideOrigin,
  isProgramOp,
  isSetupEvent,
  shadowMeta,
} from "../src/index.js";
import { makeEvent, must } from "./helpers.js";

function history(): ShadowEvent[] {
  return [
    makeEvent({ sequence: 0, eventType: "trace.started", name: "t" }),
    makeEvent({ sequence: 1, eventType: "agent.started", name: "agent" }),
    makeEvent({
      sequence: 2,
      eventType: "context.added",
      name: "user",
      output: { key: "user", value: 1 },
    }),
    makeEvent({
      sequence: 3,
      eventType: "tool.request",
      name: "lookup",
      input: { tool: "lookup", arguments: { id: 1 } },
    }),
    makeEvent({
      sequence: 4,
      eventType: "policy.evaluated",
      name: "guard",
      parentEventId: "evt_3",
    }),
    makeEvent({
      sequence: 5,
      eventType: "tool.response",
      name: "lookup",
      parentEventId: "evt_3",
      output: { result: 42 },
    }),
    makeEvent({ sequence: 6, eventType: "fork.created", name: "fork-1" }),
    makeEvent({
      sequence: 7,
      eventType: "state.snapshot",
      name: "auto-snapshot",
      metadata: { auto: true },
    }),
    makeEvent({
      sequence: 8,
      eventType: "context.added",
      name: "limit",
      metadata: { shadow: { origin: "override" } },
    }),
    makeEvent({
      sequence: 9,
      eventType: "model.request",
      name: "think",
      input: { provider: "p", model: "m", messages: [] },
    }),
    makeEvent({ sequence: 10, eventType: "model.response", name: "think", parentEventId: "evt_9" }),
    makeEvent({ sequence: 11, eventType: "agent.completed", name: "agent" }),
  ];
}

describe("event classification", () => {
  it("shadowMeta returns the shadow namespace or an empty object", () => {
    expect(shadowMeta(makeEvent({ sequence: 0 }))).toEqual({});
    expect(shadowMeta(makeEvent({ sequence: 0, metadata: { shadow: "nope" } }))).toEqual({});
    expect(
      shadowMeta(makeEvent({ sequence: 0, metadata: { shadow: { origin: "replay" } } })),
    ).toEqual({ origin: "replay" });
  });

  it("isSetupEvent covers fork, replay and override-origin events", () => {
    expect(isSetupEvent(makeEvent({ sequence: 0, eventType: "fork.created" }))).toBe(true);
    expect(isSetupEvent(makeEvent({ sequence: 0, eventType: "replay.started" }))).toBe(true);
    expect(isSetupEvent(makeEvent({ sequence: 0, eventType: "replay.failed" }))).toBe(true);
    const override = makeEvent({
      sequence: 0,
      eventType: "context.added",
      metadata: { shadow: { origin: "override" } },
    });
    expect(isOverrideOrigin(override)).toBe(true);
    expect(isSetupEvent(override)).toBe(true);
    expect(isSetupEvent(makeEvent({ sequence: 0, eventType: "context.added" }))).toBe(false);
  });

  it("isProgramOp only matches operations the program itself performed", () => {
    for (const type of OP_EVENT_TYPES)
      expect(isProgramOp(makeEvent({ sequence: 0, eventType: type }))).toBe(true);
    expect(isProgramOp(makeEvent({ sequence: 0, eventType: "tool.response" }))).toBe(false);
    expect(isProgramOp(makeEvent({ sequence: 0, eventType: "agent.started" }))).toBe(false);
    expect(
      isProgramOp(
        makeEvent({ sequence: 0, eventType: "state.snapshot", metadata: { auto: true } }),
      ),
    ).toBe(false);
    expect(isProgramOp(makeEvent({ sequence: 0, eventType: "state.snapshot" }))).toBe(true);
    expect(
      isProgramOp(
        makeEvent({
          sequence: 0,
          eventType: "context.added",
          metadata: { shadow: { origin: "override" } },
        }),
      ),
    ).toBe(false);
  });

  it("treats guard evaluations (nested under a tool request) as part of the tool operation", () => {
    expect(
      isProgramOp(
        makeEvent({
          sequence: 0,
          eventType: "policy.evaluated",
          name: "guard",
          parentEventId: "evt_req",
        }),
      ),
    ).toBe(false);
    expect(
      isProgramOp(makeEvent({ sequence: 0, eventType: "policy.evaluated", name: "standalone" })),
    ).toBe(true);
  });
});

describe("HistoryCursor", () => {
  it("serves operations in order, reporting skipped bookkeeping events and direct children", () => {
    const cursor = new HistoryCursor(history());
    expect(cursor.exhausted).toBe(false);

    const first = must(cursor.serve("context.added", "user"));
    expect(first.event.id).toBe("evt_2");
    expect(first.skipped.map((e) => e.id)).toEqual(["evt_0", "evt_1"]);
    expect(first.children).toEqual([]);

    const second = must(
      cursor.serve("tool.request", "lookup", { tool: "lookup", arguments: { id: 1 } }),
    );
    expect(second.event.id).toBe("evt_3");
    expect(second.skipped).toEqual([]);
    expect(second.children.map((e) => e.id)).toEqual(["evt_4", "evt_5"]);

    const third = must(
      cursor.serve("model.request", "think", { provider: "p", model: "m", messages: [] }),
    );
    expect(third.event.id).toBe("evt_9");
    // The guard evaluation and response belong to the served tool op; fork.created,
    // the auto snapshot and the override are bookkeeping. None of them are matched.
    expect(third.skipped.map((e) => e.id)).toEqual(["evt_4", "evt_5", "evt_6", "evt_7", "evt_8"]);
    expect(cursor.exhausted).toBe(true);
  });

  it("returns null once no operation remains and keeps skipped events drainable", () => {
    const cursor = new HistoryCursor(history());
    cursor.serve("context.added", "user");
    cursor.serve("tool.request", "lookup");
    expect(cursor.exhausted).toBe(false);
    cursor.serve("model.request", "think");
    expect(cursor.serve("tool.request", "anything")).toBeNull();
    expect(cursor.drain().map((e) => e.id)).toEqual(["evt_10", "evt_11"]);
    expect(cursor.drain()).toEqual([]);
    expect(cursor.exhausted).toBe(true);
  });

  it("does not consume trailing bookkeeping events when serving returns null", () => {
    const cursor = new HistoryCursor([
      makeEvent({ sequence: 0, eventType: "fork.created", name: "f" }),
      makeEvent({
        sequence: 1,
        eventType: "context.added",
        name: "x",
        metadata: { shadow: { origin: "override" } },
      }),
    ]);
    expect(cursor.exhausted).toBe(true);
    expect(cursor.serve("tool.request", "t")).toBeNull();
    expect(cursor.drain().map((e) => e.id)).toEqual(["evt_0", "evt_1"]);
  });

  it("throws a precise mismatch error when the program performs a different operation", () => {
    const cursor = new HistoryCursor(history());
    cursor.serve("context.added", "user");
    let caught: unknown;
    try {
      cursor.serve("model.request", "think");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ReplayHistoryMismatchError);
    const mismatch = caught as ReplayHistoryMismatchError;
    expect(mismatch.message).toMatch(
      /expected recorded tool.request 'lookup' \(sequence 3\) but the program performed model.request 'think'/,
    );
    expect(mismatch.details).toEqual({
      expectedType: "tool.request",
      expectedName: "lookup",
      actualType: "model.request",
      actualName: "think",
      sequence: 3,
      eventId: "evt_3",
    });
  });

  it("throws when the same operation is requested with different input", () => {
    const cursor = new HistoryCursor(history());
    cursor.serve("context.added", "user");
    expect(() =>
      cursor.serve("tool.request", "lookup", { tool: "lookup", arguments: { id: 2 } }),
    ).toThrow(ReplayHistoryMismatchError);
    try {
      cursor.serve("tool.request", "lookup", { tool: "lookup", arguments: { id: 2 } });
    } catch (error) {
      const details = (error as ReplayHistoryMismatchError).details;
      expect(details.recorded).toEqual({ tool: "lookup", arguments: { id: 1 } });
      expect(details.actual).toEqual({ tool: "lookup", arguments: { id: 2 } });
      expect((error as Error).message).toMatch(/differs from the recorded input/);
    }
  });

  it("ignores the input check when either side has no input", () => {
    const cursor = new HistoryCursor(history());
    cursor.serve("context.added", "user");
    expect(cursor.serve("tool.request", "lookup")?.event.id).toBe("evt_3");
    const noInput = new HistoryCursor([
      makeEvent({ sequence: 0, eventType: "tool.request", name: "t" }),
    ]);
    expect(noInput.serve("tool.request", "t", { tool: "t", arguments: {} })?.event.id).toBe(
      "evt_0",
    );
  });
});
