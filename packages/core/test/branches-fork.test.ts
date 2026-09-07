import { describe, expect, it } from "vitest";
import {
  ForkError,
  VirtualClock,
  createFork,
  resolveForkPoint,
  seededIdGenerator,
} from "../src/index.js";
import { demoTraces, findEvent, makeBranch, makeEvent, must, recordScenario } from "./helpers.js";

describe("resolveForkPoint", () => {
  const recorded = recordScenario(must(demoTraces[0]));

  it("forks at the selected event when it is an operation opener", async () => {
    const { result } = await recorded;
    const request = findEvent(result.events, "tool.request", "refund_order");
    const point = resolveForkPoint(result.events, request.id);
    expect(point.forkEvent.id).toBe(request.id);
    expect(point.selectedEvent.id).toBe(request.id);
    expect(point.forkSequence).toBe(request.sequence - 1);
  });

  it("normalises responses and errors to their request", async () => {
    const { result } = await recorded;
    const request = findEvent(result.events, "tool.request", "read_customer");
    const response = findEvent(result.events, "tool.response", "read_customer");
    const point = resolveForkPoint(result.events, response.id);
    expect(point.forkEvent.id).toBe(request.id);
    expect(point.selectedEvent.id).toBe(response.id);
    expect(point.forkSequence).toBe(request.sequence - 1);

    const modelRequest = findEvent(result.events, "model.request", "plan");
    const modelResponse = findEvent(result.events, "model.response", "plan");
    expect(resolveForkPoint(result.events, modelResponse.id).forkEvent.id).toBe(modelRequest.id);
  });

  it("normalises guard policy outcomes to the guarded tool request", async () => {
    const { result } = await recorded;
    const request = findEvent(result.events, "tool.request", "refund_order");
    const evaluated = findEvent(result.events, "policy.evaluated", "refund.autonomous_limit");
    const allowed = findEvent(result.events, "policy.allowed", "refund.autonomous_limit");
    expect(resolveForkPoint(result.events, allowed.id).forkEvent.id).toBe(request.id);
    expect(resolveForkPoint(result.events, evaluated.id).forkEvent.id).toBe(request.id);
  });

  it("normalises standalone policy outcomes to their evaluation", async () => {
    const { result } = await recorded;
    const evaluated = findEvent(result.events, "policy.evaluated", "compliance.refund_limit");
    const denied = findEvent(result.events, "policy.denied", "compliance.refund_limit");
    const point = resolveForkPoint(result.events, denied.id);
    expect(point.forkEvent.id).toBe(evaluated.id);
    expect(resolveForkPoint(result.events, evaluated.id).forkEvent.id).toBe(evaluated.id);
  });

  it("keeps plain events (state patches, notes) as their own fork point", async () => {
    const { result } = await recorded;
    const patch = findEvent(result.events, "state.patch", "/step");
    expect(resolveForkPoint(result.events, patch.id).forkEvent.id).toBe(patch.id);
  });

  it("normalises tool errors and resolved approvals to their opener", () => {
    const lineage = [
      makeEvent({ sequence: 0, eventType: "tool.request", name: "t", id: "evt_req" }),
      makeEvent({
        sequence: 1,
        eventType: "tool.error",
        name: "t",
        id: "evt_err",
        parentEventId: "evt_req",
      }),
      makeEvent({
        sequence: 2,
        eventType: "human.approval_requested",
        name: "approval",
        id: "evt_apr",
      }),
      makeEvent({
        sequence: 3,
        eventType: "human.approval_resolved",
        name: "approval",
        id: "evt_res",
        parentEventId: "evt_apr",
      }),
      makeEvent({
        sequence: 4,
        eventType: "agent.note",
        name: "child",
        id: "evt_note",
        parentEventId: "evt_res",
      }),
    ];
    expect(resolveForkPoint(lineage, "evt_err").forkEvent.id).toBe("evt_req");
    expect(resolveForkPoint(lineage, "evt_res").forkEvent.id).toBe("evt_apr");
    // A non-closer child of a non-tool parent stays where it is.
    expect(resolveForkPoint(lineage, "evt_note").forkEvent.id).toBe("evt_note");
  });

  it("rejects unknown events and replay bookkeeping events", async () => {
    const { result } = await recorded;
    expect(() => resolveForkPoint(result.events, "evt_missing")).toThrow(ForkError);
    try {
      resolveForkPoint(result.events, "evt_missing");
    } catch (error) {
      expect((error as ForkError).code).toBe("event_not_found");
    }
    const lineage = [
      makeEvent({ sequence: 0, eventType: "fork.created", name: "f", id: "evt_fork" }),
      makeEvent({ sequence: 1, eventType: "replay.started", name: "r", id: "evt_replay" }),
      makeEvent({
        sequence: 2,
        eventType: "context.added",
        name: "o",
        id: "evt_override",
        metadata: { shadow: { origin: "override" } },
      }),
    ];
    for (const id of ["evt_fork", "evt_replay", "evt_override"]) {
      expect(() => resolveForkPoint(lineage, id)).toThrow(/cannot fork from/);
      try {
        resolveForkPoint(lineage, id);
      } catch (error) {
        expect((error as ForkError).code).toBe("not_forkable");
      }
    }
  });
});

describe("createFork", () => {
  const recorded = recordScenario(must(demoTraces[0]));

  it("creates a pending child branch, a fork record and a fork.created event", async () => {
    const { result, trace, root } = await recorded;
    const selected = findEvent(result.events, "tool.response", "refund_order");
    const request = findEvent(result.events, "tool.request", "refund_order");
    const overrides = must(must(demoTraces[0]).fork).overrides;
    const created = createFork({
      trace,
      parentBranch: root,
      lineage: result.events,
      existingBranches: [root],
      forkEventId: selected.id,
      overrides: [
        { ...must(overrides[0]), id: undefined },
        { kind: "policy", policy: "p", config: {} },
      ],
      ids: seededIdGenerator("fork"),
      clock: new VirtualClock("2026-09-03T00:00:00.000Z"),
      metadata: { by: "test" },
    });

    expect(created.forkPoint.forkEvent.id).toBe(request.id);
    expect(created.forkPoint.selectedEvent.id).toBe(selected.id);

    const { branch, fork, events } = created;
    expect(branch.id).toMatch(/^br_/);
    expect(branch).toMatchObject({
      traceId: trace.id,
      name: "fork-1",
      parentBranchId: root.id,
      forkId: fork.id,
      forkEventId: request.id,
      forkSequence: request.sequence - 1,
      depth: 1,
      status: "pending",
      outcome: null,
      createdAt: "2026-09-03T00:00:00.000Z",
      updatedAt: "2026-09-03T00:00:00.000Z",
      metadata: { by: "test" },
    });
    expect(branch.metrics.eventCount).toBe(0);

    expect(fork.id).toMatch(/^frk_/);
    expect(fork).toMatchObject({
      traceId: trace.id,
      parentBranchId: root.id,
      childBranchId: branch.id,
      forkEventId: request.id,
      forkSequence: request.sequence - 1,
      metadata: { selectedEventId: selected.id },
    });
    // Missing override ids are filled in positionally; provided ids are kept.
    expect(fork.overrides.map((o) => o.id)).toEqual(["ovr_1", "ovr_2"]);

    expect(events).toHaveLength(1);
    const forkEvent = must(events[0]);
    expect(forkEvent).toMatchObject({
      eventType: "fork.created",
      branchId: branch.id,
      traceId: trace.id,
      sequence: request.sequence,
      timestamp: request.timestamp,
      source: "api",
      name: "fork-1",
      tags: ["fork"],
      input: {
        parentBranchId: root.id,
        forkEventId: request.id,
        forkSequence: request.sequence - 1,
      },
      output: { overrides: fork.overrides },
      metadata: { shadow: { origin: "replay", forkId: fork.id } },
    });
    expect(forkEvent.id).toMatch(/^evt_/);
  });

  it("uses the provided name (trimmed) and generates unique default names", async () => {
    const { result, trace, root } = await recorded;
    const request = findEvent(result.events, "tool.request", "refund_order");
    const base = {
      trace,
      parentBranch: root,
      lineage: result.events,
      forkEventId: request.id,
      overrides: [],
      clock: new VirtualClock(0),
    };
    const named = createFork({
      ...base,
      existingBranches: [root],
      name: "  what-if  ",
      ids: seededIdGenerator("a"),
    });
    expect(named.branch.name).toBe("what-if");
    expect(must(named.events[0]).name).toBe("what-if");
    const blank = createFork({
      ...base,
      existingBranches: [root, makeBranch({ id: "br_x", name: "fork-1" })],
      name: "   ",
      ids: seededIdGenerator("b"),
    });
    expect(blank.branch.name).toBe("fork-2");
  });

  it("is deterministic for the same id generator and clock", async () => {
    const { result, trace, root } = await recorded;
    const request = findEvent(result.events, "tool.request", "refund_order");
    const make = () =>
      createFork({
        trace,
        parentBranch: root,
        lineage: result.events,
        existingBranches: [root],
        forkEventId: request.id,
        overrides: [],
        ids: seededIdGenerator("same"),
        clock: new VirtualClock(0),
      });
    expect(JSON.stringify(make())).toBe(JSON.stringify(make()));
  });

  it("increments depth for nested forks", async () => {
    const { result, trace, root } = await recorded;
    const request = findEvent(result.events, "tool.request", "refund_order");
    const child = makeBranch({ id: "br_child", parentBranchId: root.id, depth: 3 });
    const nested = createFork({
      trace,
      parentBranch: child,
      lineage: result.events,
      existingBranches: [root, child],
      forkEventId: request.id,
      overrides: [],
      ids: seededIdGenerator("n"),
      clock: new VirtualClock(0),
    });
    expect(nested.branch.depth).toBe(4);
    expect(nested.branch.parentBranchId).toBe("br_child");
  });

  it("propagates ForkError for bad fork points", async () => {
    const { result, trace, root } = await recorded;
    expect(() =>
      createFork({
        trace,
        parentBranch: root,
        lineage: result.events,
        existingBranches: [root],
        forkEventId: "evt_missing",
        overrides: [],
        ids: seededIdGenerator("x"),
        clock: new VirtualClock(0),
      }),
    ).toThrow(ForkError);
  });
});
