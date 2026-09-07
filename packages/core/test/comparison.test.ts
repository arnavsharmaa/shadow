import type { ShadowEvent } from "@shadow/schemas";
import { describe, expect, it } from "vitest";
import {
  compareBranches,
  deriveOutcome,
  diffEventFields,
  summariseToolCalls,
  toEventRef,
  type CompareSide,
} from "../src/index.js";
import {
  asObject,
  demoTraces,
  findEvent,
  forkAndReplay,
  makeBranch,
  makeEvent,
  must,
  recordScenario,
  type ForkedReplay,
  type Recorded,
} from "./helpers.js";

const refundSpec = must(demoTraces[0]);
const inventorySpec = must(demoTraces[1]);

async function refundFork(recorded: Recorded): Promise<ForkedReplay> {
  return forkAndReplay({
    trace: recorded.trace,
    definition: refundSpec.agent,
    parentBranch: recorded.root,
    parentLineage: recorded.result.events,
    existingBranches: [recorded.root],
    forkEventId: findEvent(recorded.result.events, "tool.request", "refund_order").id,
    overrides: must(refundSpec.fork).overrides,
    name: "fork-1",
  });
}

describe("compareBranches on the refund demo", () => {
  const recorded = recordScenario(refundSpec);
  const forked = recorded.then(refundFork);
  const comparison = Promise.all([recorded, forked]).then(([r, child]) =>
    compareBranches(
      { branch: r.root, events: r.result.events },
      { branch: child.branch, events: child.lineage },
      { overrides: child.fork.overrides },
    ),
  );

  it("describes both sides and the shared prefix", async () => {
    const [r, child, result] = await Promise.all([recorded, forked, comparison]);
    expect(result.base).toEqual({
      branchId: r.root.id,
      name: "main",
      metrics: r.result.metrics,
      outcome: r.result.outcome,
      eventCount: r.result.events.length,
    });
    expect(result.target.branchId).toBe(child.branch.id);
    expect(result.target.name).toBe("fork-1");
    expect(result.target.eventCount).toBe(child.lineage.length);
    expect(result.sharedUntilSequence).toBe(must(child.branch.forkSequence));
    expect(result.overrides).toEqual(child.fork.overrides);
  });

  it("finds the first divergence at the guard policy evaluation", async () => {
    const result = await comparison;
    const divergence = must(result.firstDivergence);
    expect(divergence.reason).toBe("output_changed");
    expect(divergence.base?.eventType).toBe("policy.evaluated");
    expect(divergence.base?.name).toBe("refund.autonomous_limit");
    expect(divergence.target?.eventType).toBe("policy.evaluated");
    expect(divergence.sequence).toBe(divergence.base?.sequence);
    expect(divergence.summary).toBe(
      'policy.evaluated \'refund.autonomous_limit\': output.decision changed from "allow" to "approval_required"',
    );
    expect(divergence.fields.map((f) => f.path)).toEqual([
      "output.decision",
      "output.details.limit",
      "output.reason",
      "severity",
    ]);
    expect(must(divergence.fields[0])).toEqual({
      path: "output.decision",
      before: "allow",
      after: "approval_required",
    });
    expect(must(divergence.fields[1])).toEqual({
      path: "output.details.limit",
      before: 500,
      after: 100,
    });
    expect(must(result.steps[divergence.stepIndex]).kind).toBe("modified");
  });

  it("aligns steps as shared prefix, override setup, then LCS-aligned suffix", async () => {
    const [r, child, result] = await Promise.all([recorded, forked, comparison]);
    const forkSequence = must(child.branch.forkSequence);
    const kinds = result.steps.map((s) => s.kind);
    expect(result.steps.map((s) => s.index)).toEqual(result.steps.map((_, i) => i));
    expect(kinds.slice(0, forkSequence + 1).every((k) => k === "shared")).toBe(true);
    const shared = result.steps.filter((s) => s.kind === "shared");
    expect(shared).toHaveLength(forkSequence + 1);
    expect(shared.every((s) => s.base?.id === s.target?.id)).toBe(true);

    const setup = result.steps.filter((s) => s.kind === "override");
    expect(setup.map((s) => [s.target?.eventType, s.target?.name])).toEqual([
      ["fork.created", "fork-1"],
      ["replay.started", "deterministic"],
      ["context.added", "refundLimit"],
      ["replay.completed", "deterministic"],
    ]);
    expect(setup.every((s) => s.base === null)).toBe(true);
    expect(kinds.indexOf("override")).toBe(forkSequence + 1);

    const suffix = result.steps.slice(forkSequence + 1 + setup.length);
    expect(must(suffix[0])).toMatchObject({
      kind: "same",
      base: { eventType: "tool.request", name: "refund_order" },
    });
    expect(suffix.every((s) => ["same", "modified", "added", "removed"].includes(s.kind))).toBe(
      true,
    );
    // Base suffix (excluding setup) is fully accounted for, as is the target suffix.
    const baseSuffix = r.result.events.filter((e) => e.sequence > forkSequence);
    const targetSuffix = child.replay.events;
    expect(suffix.filter((s) => s.base).length).toBe(baseSuffix.length);
    expect(
      suffix.filter((s) => s.target).length +
        setup.length -
        1 /* fork.created is not a replay event */,
    ).toBe(targetSuffix.length);
    expect(result.removedEvents.map((e) => e.eventType)).toEqual([
      "policy.allowed",
      "tool.response",
      "policy.denied",
      "trace.failed",
    ]);
    expect(result.addedEvents.map((e) => e.eventType)).toEqual([
      "policy.approval_required",
      "tool.error",
      "human.approval_requested",
      "state.patch",
      "policy.allowed",
      "trace.completed",
    ]);
    expect(result.modifiedEvents.length).toBeGreaterThan(3);
    expect(result.modifiedEvents.every((m) => m.fields.length > 0)).toBe(true);
  });

  it("reports outcome, policy, metrics, context, state and tool-call changes", async () => {
    const result = await comparison;
    expect(result.outcome.base?.kind).toBe("policy_violation");
    expect(result.outcome.target?.kind).toBe("approval_pending");
    expect(result.outcome.changed).toBe(true);

    expect(result.policy.base).toEqual({ allow: 1, deny: 1, approval_required: 0 });
    expect(result.policy.target).toEqual({ allow: 1, deny: 0, approval_required: 1 });
    expect(result.policy.changed).toBe(true);
    expect(result.policy.baseDecisions.map((d) => [d.policy, d.decision])).toEqual([
      ["refund.autonomous_limit", "allow"],
      ["compliance.refund_limit", "deny"],
    ]);
    expect(result.policy.targetDecisions.map((d) => [d.policy, d.decision])).toEqual([
      ["refund.autonomous_limit", "approval_required"],
      ["compliance.refund_limit", "allow"],
    ]);
    expect(must(result.policy.baseDecisions[1]).reason).toMatch(/exceeds the company limit/);

    expect(result.metrics.totalEstimatedCost.delta).toBeLessThan(0);
    expect(result.metrics.durationMs.delta).toBeLessThan(0);
    expect(result.metrics.durationMs.percent).toBeCloseTo(
      result.metrics.durationMs.delta / result.metrics.durationMs.base,
    );
    expect(result.metrics.toolCalls).toEqual({ base: 6, target: 6, delta: 0, percent: 0 });
    expect(result.metrics.modelCalls.delta).toBe(0);
    expect(result.metrics.eventCount.delta).toBe(result.target.eventCount - result.base.eventCount);

    expect(result.context.diff).toEqual([
      { path: "/refundLimit", op: "changed", before: 500, after: 100 },
    ]);
    expect(result.state.diff.some((d) => d.path === "/approval" && d.op === "added")).toBe(true);
    expect(result.state.diff.some((d) => d.path.startsWith("/refund/"))).toBe(true);

    expect(result.toolCalls.base.map((t) => [t.tool, t.status])).toEqual([
      ["read_customer", "ok"],
      ["search_orders", "ok"],
      ["inspect_order", "ok"],
      ["read_policy", "ok"],
      ["refund_order", "ok"],
      ["send_email", "ok"],
    ]);
    expect(result.toolCalls.target.find((t) => t.tool === "refund_order")?.status).toBe("error");
    expect(result.toolCalls.diffs.map((d) => [d.tool, d.kind])).toEqual([
      ["refund_order", "status"],
      ["send_email", "arguments"],
    ]);
    const mail = must(result.toolCalls.diffs[1]);
    expect(mail.fields.some((f) => f.path === "arguments.subject")).toBe(true);
  });

  it("falls back to greedy alignment for large suffixes and still finds the divergence", async () => {
    const [r, child] = await Promise.all([recorded, forked]);
    const greedy = compareBranches(
      { branch: r.root, events: r.result.events },
      { branch: child.branch, events: child.lineage },
      { maxDpCells: 1 },
    );
    const lcs = await comparison;
    expect(greedy.firstDivergence?.base?.id).toBe(lcs.firstDivergence?.base?.id);
    expect(greedy.firstDivergence?.reason).toBe("output_changed");
    expect(greedy.steps.filter((s) => s.kind === "shared")).toHaveLength(
      must(child.branch.forkSequence) + 1,
    );
    expect(greedy.steps.filter((s) => s.kind === "same").length).toBeGreaterThan(0);
    // Every suffix event is placed exactly once on each side.
    const baseSuffix = r.result.events.filter((e) => e.sequence > must(child.branch.forkSequence));
    expect(
      greedy.steps.filter((s) => s.kind !== "shared" && s.base).map((s) => s.base?.id),
    ).toEqual(baseSuffix.map((e) => e.id));
    expect(greedy.outcome.changed).toBe(true);
    expect(greedy.metrics).toEqual(lcs.metrics);
  });

  it("prefers the branch's stored outcome over the derived one", async () => {
    const [r, child] = await Promise.all([recorded, forked]);
    const stored = { kind: "custom", label: "Stored" };
    const result = compareBranches(
      { branch: { ...r.root, outcome: stored }, events: r.result.events },
      { branch: { ...child.branch, outcome: null }, events: child.lineage },
    );
    expect(result.base.outcome).toEqual(stored);
    expect(result.target.outcome?.kind).toBe("approval_pending");
    expect(result.overrides).toEqual([]);
  });
});

describe("compareBranches on identical and re-recorded branches", () => {
  it("reports no divergence when a branch is compared with itself", async () => {
    const r = await recordScenario(refundSpec);
    const side: CompareSide = { branch: r.root, events: r.result.events };
    const result = compareBranches(side, side);
    expect(result.firstDivergence).toBeNull();
    expect(result.sharedUntilSequence).toBe(must(r.result.events.at(-1)).sequence);
    expect(result.steps.every((s) => s.kind === "shared")).toBe(true);
    expect(result.addedEvents).toEqual([]);
    expect(result.removedEvents).toEqual([]);
    expect(result.modifiedEvents).toEqual([]);
    expect(result.outcome.changed).toBe(false);
    expect(result.policy.changed).toBe(false);
    expect(result.context.diff).toEqual([]);
    expect(result.state.diff).toEqual([]);
    expect(result.toolCalls.diffs).toEqual([]);
    expect(result.metrics.eventCount).toEqual({
      base: r.result.events.length,
      target: r.result.events.length,
      delta: 0,
      percent: 0,
    });
  });

  it("treats a second recording with different ids as all-'same' steps", async () => {
    const a = await recordScenario(refundSpec);
    const b = await recordScenario({
      ...refundSpec,
      seed: "another-seed",
      traceId: "trc_other",
      rootBranchId: "br_other",
    });
    const result = compareBranches(
      { branch: a.root, events: a.result.events },
      { branch: b.root, events: b.result.events },
    );
    expect(result.sharedUntilSequence).toBe(-1);
    expect(result.firstDivergence).toBeNull();
    expect(result.steps.every((s) => s.kind === "same")).toBe(true);
    expect(result.steps).toHaveLength(a.result.events.length);
    expect(result.outcome.changed).toBe(false);
    expect(result.metrics.totalEstimatedCost.delta).toBe(0);
  });
});

describe("compareBranches on hand-built events", () => {
  const base: ShadowEvent[] = [
    makeEvent({ sequence: 0, id: "shared_0", eventType: "trace.started", name: "t" }),
    makeEvent({
      sequence: 1,
      id: "shared_1",
      eventType: "tool.request",
      name: "a",
      input: { tool: "a", arguments: { x: 1 } },
    }),
    makeEvent({
      sequence: 2,
      id: "base_2",
      eventType: "tool.response",
      name: "a",
      parentEventId: "shared_1",
      output: { result: 1 },
      durationMs: 5,
    }),
    makeEvent({
      sequence: 3,
      id: "base_3",
      eventType: "tool.request",
      name: "b",
      input: { tool: "b", arguments: {} },
    }),
    makeEvent({
      sequence: 4,
      id: "base_4",
      eventType: "tool.response",
      name: "b",
      parentEventId: "base_3",
      output: { result: 2 },
    }),
    makeEvent({
      sequence: 5,
      id: "base_5",
      eventType: "trace.completed",
      name: "t",
      output: { outcome: { kind: "done", label: "Done" } },
    }),
  ];
  const target: ShadowEvent[] = [
    must(base[0]),
    must(base[1]),
    makeEvent({
      sequence: 2,
      id: "t_2",
      eventType: "fork.created",
      name: "fork-1",
      branchId: "br_child",
    }),
    makeEvent({
      sequence: 3,
      id: "t_3",
      eventType: "tool.response",
      name: "a",
      parentEventId: "shared_1",
      output: { result: 1 },
      durationMs: 9,
      branchId: "br_child",
    }),
    makeEvent({
      sequence: 4,
      id: "t_4",
      eventType: "agent.note",
      name: "extra",
      branchId: "br_child",
    }),
    makeEvent({
      sequence: 5,
      id: "t_5",
      eventType: "tool.request",
      name: "c",
      input: { tool: "c", arguments: {} },
      branchId: "br_child",
    }),
    makeEvent({
      sequence: 6,
      id: "t_6",
      eventType: "tool.error",
      name: "c",
      parentEventId: "t_5",
      output: { error: { message: "nope" } },
      severity: "error",
      branchId: "br_child",
    }),
    makeEvent({
      sequence: 7,
      id: "t_7",
      eventType: "trace.failed",
      name: "t",
      output: { error: { message: "nope" } },
      branchId: "br_child",
    }),
  ];
  const baseBranch = makeBranch({ id: "br_root" });
  const targetBranch = makeBranch({ id: "br_child", parentBranchId: "br_root", forkSequence: 1 });

  it("detects added, removed and modified events around a shared prefix", () => {
    const result = compareBranches(
      { branch: baseBranch, events: base },
      { branch: targetBranch, events: target },
    );
    expect(result.sharedUntilSequence).toBe(1);
    // With no common subsequence left, removals are emitted before additions.
    expect(result.steps.map((s) => s.kind)).toEqual([
      "shared",
      "shared",
      "override",
      "same",
      "removed",
      "removed",
      "removed",
      "added",
      "added",
      "added",
      "added",
    ]);
    expect(result.addedEvents.map((e) => e.id)).toEqual(["t_4", "t_5", "t_6", "t_7"]);
    expect(result.removedEvents.map((e) => e.id)).toEqual(["base_3", "base_4", "base_5"]);
    expect(result.modifiedEvents).toEqual([]);
    const divergence = must(result.firstDivergence);
    expect(divergence).toMatchObject({
      reason: "event_removed",
      stepIndex: 4,
      sequence: 3,
      target: null,
      summary: "tool.request 'b' only happens in the original",
    });
    expect(divergence.base?.id).toBe("base_3");
    const added = must(result.steps[7]);
    expect(added).toMatchObject({ kind: "added", base: null });
    expect(added.target?.id).toBe("t_4");
    expect(result.outcome.base).toEqual({ kind: "done", label: "Done" });
    expect(result.outcome.target).toEqual({ kind: "error", label: "nope" });
    expect(result.toolCalls.diffs.map((d) => [d.tool, d.kind])).toEqual([
      ["b", "removed"],
      ["c", "added"],
    ]);
    expect(result.policy.base).toEqual({ allow: 0, deny: 0, approval_required: 0 });
  });

  it("describes removed events and result changes as the first divergence", () => {
    const shorter = base.slice(0, 3);
    const removedResult = compareBranches(
      { branch: baseBranch, events: base },
      { branch: baseBranch, events: shorter },
    );
    expect(removedResult.firstDivergence).toMatchObject({
      reason: "event_removed",
      summary: "tool.request 'b' only happens in the original",
    });

    const changed = base.map((e) =>
      e.id === "base_4"
        ? { ...e, id: "changed_4", parentEventId: "changed_3", output: { result: 3 } }
        : e.id === "base_3"
          ? { ...e, id: "changed_3" }
          : e,
    );
    const modifiedResult = compareBranches(
      { branch: baseBranch, events: base },
      { branch: baseBranch, events: changed },
    );
    expect(modifiedResult.sharedUntilSequence).toBe(2);
    expect(modifiedResult.firstDivergence).toMatchObject({
      reason: "output_changed",
      summary: "tool.response 'b': output.result changed from 2 to 3",
    });
    expect(modifiedResult.toolCalls.diffs).toEqual([
      expect.objectContaining({
        tool: "b",
        kind: "result",
        fields: [{ path: "result", before: 2, after: 3 }],
      }),
    ]);
    expect(modifiedResult.metrics.eventCount.percent).toBe(0);
  });

  it("classifies divergence reasons by the first differing field", () => {
    const a = makeEvent({
      sequence: 0,
      eventType: "tool.request",
      name: "x",
      input: { v: 1 },
      output: { r: 1 },
      severity: "info",
    });
    expect(diffEventFields(a, { ...a, eventType: "model.request" }).map((f) => f.path)).toEqual([
      "eventType",
    ]);
    expect(diffEventFields(a, { ...a, name: "y" })).toEqual([
      { path: "name", before: "x", after: "y" },
    ]);
    expect(diffEventFields(a, { ...a, input: { v: 2 }, severity: "warn" })).toEqual([
      { path: "input.v", before: 1, after: 2 },
      { path: "severity", before: "info", after: "warn" },
    ]);
    expect(diffEventFields(a, { ...a, output: undefined })).toEqual([
      { path: "output", before: { r: 1 }, after: undefined },
    ]);
    expect(diffEventFields(a, a)).toEqual([]);

    const typeChanged = compareBranches(
      {
        branch: baseBranch,
        events: [makeEvent({ sequence: 0, id: "p", eventType: "tool.request", name: "x" })],
      },
      {
        branch: baseBranch,
        events: [
          makeEvent({
            sequence: 0,
            id: "q",
            eventType: "tool.request",
            name: "x",
            input: { changed: true },
          }),
        ],
      },
    );
    expect(typeChanged.firstDivergence?.reason).toBe("input_changed");
    const nameChanged = compareBranches(
      {
        branch: baseBranch,
        events: [makeEvent({ sequence: 0, id: "p", eventType: "tool.request", name: "x" })],
      },
      {
        branch: baseBranch,
        events: [makeEvent({ sequence: 0, id: "q", eventType: "tool.request", name: "y" })],
      },
    );
    // Different signatures never align, so this shows up as removed + added.
    expect(nameChanged.firstDivergence?.reason).toBe("event_removed");
  });

  it("uses percent=null for metrics whose base is zero", () => {
    const result = compareBranches(
      { branch: baseBranch, events: [] },
      { branch: targetBranch, events: target },
    );
    expect(result.metrics.eventCount.percent).toBeNull();
    expect(result.metrics.eventCount.delta).toBe(target.length);
    expect(result.sharedUntilSequence).toBe(-1);
    expect(result.steps.filter((s) => s.kind === "shared")).toHaveLength(0);
  });
});

describe("deriveOutcome", () => {
  it("reads the declared outcome from the last trace end event", () => {
    const events = [
      makeEvent({
        sequence: 0,
        eventType: "trace.completed",
        name: "t",
        output: { outcome: { kind: "first", label: "First" } },
      }),
      makeEvent({
        sequence: 1,
        eventType: "trace.failed",
        name: "t",
        output: { outcome: { kind: "second", label: "Second" } },
      }),
    ];
    expect(deriveOutcome(events)).toEqual({ kind: "second", label: "Second" });
  });

  it("synthesises an outcome from the error or event name when none was declared", () => {
    expect(
      deriveOutcome([
        makeEvent({
          sequence: 0,
          eventType: "trace.failed",
          name: "trace.failed",
          output: { error: { message: "boom" } },
        }),
      ]),
    ).toEqual({ kind: "error", label: "boom" });
    expect(
      deriveOutcome([makeEvent({ sequence: 0, eventType: "trace.completed", name: "done" })]),
    ).toEqual({ kind: "completed", label: "done" });
    expect(
      deriveOutcome([
        makeEvent({
          sequence: 0,
          eventType: "trace.completed",
          name: "done",
          output: { outcome: "not-an-object" },
        }),
      ]),
    ).toEqual({ kind: "completed", label: "done" });
  });

  it("returns null when the trace never ended", () => {
    expect(
      deriveOutcome([makeEvent({ sequence: 0, eventType: "trace.started", name: "t" })]),
    ).toBeNull();
    expect(deriveOutcome([])).toBeNull();
  });
});

describe("summariseToolCalls", () => {
  it("pairs requests with their response or error", async () => {
    const r = await recordScenario(inventorySpec);
    const calls = summariseToolCalls(r.result.events);
    expect(calls.map((c) => [c.tool, c.status])).toEqual([
      ["inventory.lookup", "error"],
      ["inventory.lookup", "error"],
      ["inventory.lookup", "error"],
      ["inventory.cached_lookup", "ok"],
      ["orders.create_backorder", "ok"],
    ]);
    const failed = must(calls[0]);
    expect(failed.eventId).toBe(findEvent(r.result.events, "tool.request", "inventory.lookup").id);
    expect(failed.arguments).toEqual({ sku: "SKU-7781", warehouse: "wh-east" });
    expect(asObject(failed.error)).toMatchObject({ code: "ETIMEDOUT", retryable: true });
    expect(failed.result).toBeUndefined();
    expect(failed.durationMs).toBe(2000);
    const ok = must(calls[3]);
    expect(asObject(ok.result)).toMatchObject({ sku: "SKU-7781", stale: true });
    expect(ok.error).toBeUndefined();
    expect(ok.durationMs).toBe(35);
  });

  it("handles requests without a child and without tool input", () => {
    const calls = summariseToolCalls([
      makeEvent({ sequence: 0, eventType: "tool.request", name: "orphan" }),
    ]);
    expect(calls).toEqual([
      {
        eventId: "evt_0",
        sequence: 0,
        tool: "orphan",
        arguments: undefined,
        status: "ok",
        durationMs: null,
      },
    ]);
  });
});

describe("toEventRef", () => {
  it("projects the identifying fields of an event", () => {
    const event = makeEvent({ sequence: 3, durationMs: 12, eventType: "tool.request", name: "t" });
    expect(toEventRef(event)).toEqual({
      id: "evt_3",
      branchId: "br_root",
      sequence: 3,
      eventType: "tool.request",
      name: "t",
      timestamp: event.timestamp,
      durationMs: 12,
    });
    expect(toEventRef(makeEvent({ sequence: 0 })).durationMs).toBeNull();
  });
});
