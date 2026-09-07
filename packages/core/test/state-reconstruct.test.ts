import type { ShadowEvent } from "@shadow/schemas";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SNAPSHOT_POLICY,
  STATE_MUTATING_EVENT_TYPES,
  StateReconstructionError,
  reconstructState,
  recordExecution,
  stateAround,
  type AgentDefinition,
} from "../src/index.js";
import { findEvent, ledgerAdapters, makeEvent, must, ofType } from "./helpers.js";

function timeline(): ShadowEvent[] {
  return [
    makeEvent({ sequence: 0, eventType: "trace.started", name: "t" }),
    makeEvent({
      sequence: 1,
      eventType: "context.added",
      name: "user",
      output: { key: "user", value: "u1" },
      stateVersion: 1,
    }),
    makeEvent({
      sequence: 2,
      eventType: "state.patch",
      name: "/a",
      output: { ops: [{ op: "add", path: "/a", value: { b: 1 } }] },
      stateVersion: 2,
    }),
    makeEvent({ sequence: 3, eventType: "agent.note", name: "noise" }),
    makeEvent({
      sequence: 4,
      eventType: "state.patch",
      name: "/a/c",
      output: { ops: [{ op: "add", path: "/a/c", value: [1, 2] }] },
      stateVersion: 3,
    }),
    makeEvent({
      sequence: 5,
      eventType: "state.snapshot",
      name: "snapshot",
      output: { state: { a: { b: 1, c: [1, 2] } }, context: { user: "u1" } },
      stateVersion: 3,
    }),
    makeEvent({
      sequence: 6,
      eventType: "context.removed",
      name: "user",
      output: { key: "user" },
      stateVersion: 4,
    }),
    makeEvent({
      sequence: 7,
      eventType: "state.patch",
      name: "/a/b",
      output: { ops: [{ op: "replace", path: "/a/b", value: 2 }] },
      stateVersion: 5,
    }),
    makeEvent({ sequence: 8, eventType: "trace.completed", name: "t" }),
  ];
}

describe("reconstructState", () => {
  it("returns an empty document for no events", () => {
    expect(reconstructState([])).toEqual({
      state: {},
      context: {},
      stateVersion: 0,
      asOfSequence: -1,
      fromSnapshotSequence: null,
      appliedEvents: 0,
    });
  });

  it("replays the full timeline from scratch when snapshots are disabled", () => {
    const result = reconstructState(timeline(), { useSnapshots: false });
    expect(result.state).toEqual({ a: { b: 2, c: [1, 2] } });
    expect(result.context).toEqual({});
    expect(result.fromSnapshotSequence).toBeNull();
    expect(result.appliedEvents).toBe(6);
    expect(result.asOfSequence).toBe(8);
    expect(result.stateVersion).toBe(5);
  });

  it("starts from the latest snapshot at or before the target by default", () => {
    const result = reconstructState(timeline());
    expect(result.state).toEqual({ a: { b: 2, c: [1, 2] } });
    expect(result.fromSnapshotSequence).toBe(5);
    expect(result.appliedEvents).toBe(2);
    expect(result.stateVersion).toBe(5);
  });

  it("produces the same state with and without snapshots", () => {
    const events = timeline();
    for (const upToSequence of [0, 2, 4, 5, 6, 7, 8]) {
      const fast = reconstructState(events, { upToSequence });
      const slow = reconstructState(events, { upToSequence, useSnapshots: false });
      expect(fast.state).toEqual(slow.state);
      expect(fast.context).toEqual(slow.context);
      expect(fast.asOfSequence).toBe(slow.asOfSequence);
    }
  });

  it("honours upToSequence (inclusive) and ignores snapshots after the target", () => {
    const at4 = reconstructState(timeline(), { upToSequence: 4 });
    expect(at4.state).toEqual({ a: { b: 1, c: [1, 2] } });
    expect(at4.context).toEqual({ user: "u1" });
    expect(at4.fromSnapshotSequence).toBeNull();
    expect(at4.asOfSequence).toBe(4);
    expect(at4.appliedEvents).toBe(3);

    const at5 = reconstructState(timeline(), { upToSequence: 5 });
    expect(at5.fromSnapshotSequence).toBe(5);
    expect(at5.appliedEvents).toBe(0);
    expect(at5.state).toEqual({ a: { b: 1, c: [1, 2] } });
  });

  it("honours upToEventId and rejects unknown event ids", () => {
    const result = reconstructState(timeline(), { upToEventId: "evt_2" });
    expect(result.state).toEqual({ a: { b: 1 } });
    expect(result.asOfSequence).toBe(2);
    expect(() => reconstructState(timeline(), { upToEventId: "evt_nope" })).toThrow(
      StateReconstructionError,
    );
    try {
      reconstructState(timeline(), { upToEventId: "evt_nope" });
    } catch (error) {
      expect((error as StateReconstructionError).eventId).toBe("evt_nope");
    }
  });

  it("derives the state version from the number of mutations when events carry none", () => {
    const events = timeline().map((e) => ({ ...e, stateVersion: null }));
    expect(reconstructState(events, { useSnapshots: false }).stateVersion).toBe(6);
    expect(reconstructState(events).stateVersion).toBe(2);
  });

  it("rejects invalid payloads with the offending event id", () => {
    const badPatch = [
      makeEvent({ sequence: 0, eventType: "state.patch", name: "/a", output: { ops: "nope" } }),
    ];
    expect(() => reconstructState(badPatch)).toThrow(/invalid state.patch payload on evt_0/);
    const badSnapshot = [
      makeEvent({ sequence: 0, eventType: "state.snapshot", name: "s", output: { state: 1 } }),
    ];
    expect(() => reconstructState(badSnapshot)).toThrow(/invalid state.snapshot payload/);
    expect(() => reconstructState(badSnapshot, { useSnapshots: false })).toThrow(
      StateReconstructionError,
    );
    const badContext = [
      makeEvent({ sequence: 0, eventType: "context.added", name: "k", output: { value: 1 } }),
    ];
    expect(() => reconstructState(badContext)).toThrow(/invalid context.added payload/);
    const badRemoval = [
      makeEvent({ sequence: 0, eventType: "context.removed", name: "k", output: {} }),
    ];
    expect(() => reconstructState(badRemoval)).toThrow(/invalid context.removed payload/);
  });

  it("falls back to an empty object when a patch replaces the root with a non-object", () => {
    const events = [
      makeEvent({
        sequence: 0,
        eventType: "state.patch",
        name: "(root)",
        output: { ops: [{ op: "replace", path: "", value: [1] }] },
      }),
    ];
    expect(reconstructState(events).state).toEqual({});
  });
});

describe("stateAround", () => {
  it("returns the state before and after the event", () => {
    const { before, after } = stateAround(timeline(), "evt_7");
    expect(before.state).toEqual({ a: { b: 1, c: [1, 2] } });
    expect(after.state).toEqual({ a: { b: 2, c: [1, 2] } });
    expect(before.asOfSequence).toBe(6);
    expect(after.asOfSequence).toBe(7);
  });

  it("returns an empty state before the first event", () => {
    const { before } = stateAround(timeline(), "evt_0");
    expect(before.asOfSequence).toBe(-1);
    expect(before.state).toEqual({});
  });

  it("throws for unknown events", () => {
    expect(() => stateAround(timeline(), "evt_404")).toThrow(StateReconstructionError);
  });
});

describe("snapshot policy", () => {
  it("defaults to a snapshot every 25 mutations and exports the mutating types", () => {
    expect(DEFAULT_SNAPSHOT_POLICY).toEqual({ everyMutations: 25 });
    expect([...STATE_MUTATING_EVENT_TYPES].sort()).toEqual([
      "context.added",
      "context.removed",
      "state.patch",
      "state.snapshot",
    ]);
  });

  it("emits auto snapshots that reconstruction uses as starting points", async () => {
    const definition: AgentDefinition<{ n: number }> = {
      slug: "mutator",
      name: "Mutator",
      snapshotPolicy: { everyMutations: 4 },
      createAdapters: () => ledgerAdapters().adapters,
      async program(host, input) {
        for (let i = 0; i < input.n; i++) host.state.set(`/k${i}`, i);
        host.context.set("done", true);
      },
    };
    const { events } = await recordExecution({
      definition,
      input: { n: 10 },
      traceId: "trc_snap",
      branchId: "br_snap",
      traceName: "snapshots",
      seed: "snap",
      startAt: "2026-01-01T00:00:00.000Z",
    });
    const snapshots = ofType(events, "state.snapshot");
    // 11 mutations with a snapshot every 4 → after the 4th and 8th.
    expect(snapshots).toHaveLength(2);
    for (const snapshot of snapshots) {
      expect(snapshot.metadata.auto).toBe(true);
      expect(snapshot.name).toBe("auto-snapshot");
      expect(snapshot.severity).toBe("debug");
    }
    const lastSnapshot = must(snapshots[1]);
    const withSnapshots = reconstructState(events);
    const without = reconstructState(events, { useSnapshots: false });
    expect(withSnapshots.fromSnapshotSequence).toBe(lastSnapshot.sequence);
    expect(withSnapshots.appliedEvents).toBeLessThan(without.appliedEvents);
    expect(withSnapshots.state).toEqual(without.state);
    expect(withSnapshots.context).toEqual({ done: true });
    expect(withSnapshots.state).toEqual(
      Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, i])),
    );
    // The snapshot captures state as of its own event.
    const atSnapshot = reconstructState(events, {
      upToEventId: findEvent(events, "state.snapshot").id,
    });
    expect(atSnapshot.state).toEqual({ k0: 0, k1: 1, k2: 2, k3: 3 });
  });
});
