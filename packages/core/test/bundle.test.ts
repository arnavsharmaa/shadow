import type { TraceExport } from "@shadow/schemas";
import { describe, expect, it } from "vitest";
import {
  BundleValidationError,
  compareBranches,
  parseBundle,
  regenerateBundleIds,
  seededIdGenerator,
} from "../src/index.js";
import {
  demoTraces,
  findEvent,
  forkAndReplay,
  makeBranch,
  makeBundle,
  makeEvent,
  makeFork,
  must,
  recordScenario,
} from "./helpers.js";

function issuesOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (error) {
    if (error instanceof BundleValidationError) return error.issues;
    throw error;
  }
  throw new Error("expected parseBundle to throw");
}

describe("parseBundle", () => {
  it("accepts a well-formed bundle and applies schema defaults", () => {
    const bundle = parseBundle(makeBundle());
    expect(bundle.format).toBe("shadow.trace");
    expect(bundle.comparisons).toEqual([]);
    expect(bundle.events).toHaveLength(3);
    expect(bundle.trace.rootBranchId).toBe("br_root");
  });

  it("rejects bundles that do not match the format", () => {
    expect(() => parseBundle(makeBundle({ format: "other" }))).toThrow(BundleValidationError);
    const issues = issuesOf(() => parseBundle(makeBundle({ format: "other" })));
    expect(issues.some((i) => i.startsWith("format"))).toBe(true);
    expect(() => parseBundle({})).toThrow(/does not match the shadow.trace format/);
    expect(() => parseBundle(null)).toThrow(BundleValidationError);
  });

  it("reports structural problems as issues", () => {
    expect(issuesOf(() => parseBundle(makeBundle({ schemaVersion: "2.0" })))).toEqual([
      "unsupported schemaVersion 2.0",
    ]);
    const missingRoot = makeBundle({
      trace: { rootBranchId: "br_missing" },
      branches: [makeBranch({ id: "br_root" })],
      events: [makeEvent({ sequence: 0 })],
    });
    expect(issuesOf(() => parseBundle(missingRoot))).toEqual(["root branch br_missing missing"]);

    const foreignBranch = makeBundle({
      branches: [makeBranch({ id: "br_root", traceId: "trc_other" })],
    });
    expect(issuesOf(() => parseBundle(foreignBranch))).toEqual([
      "branch br_root belongs to another trace",
    ]);

    const missingParent = makeBundle({
      branches: [
        makeBranch({ id: "br_root" }),
        makeBranch({ id: "br_child", parentBranchId: "br_ghost" }),
      ],
    });
    expect(issuesOf(() => parseBundle(missingParent))).toEqual([
      "branch br_child references missing parent br_ghost",
    ]);

    const badEvents = makeBundle({
      events: [
        makeEvent({ sequence: 0, id: "evt_dup" }),
        makeEvent({ sequence: 1, id: "evt_dup" }),
        makeEvent({ sequence: 2, id: "evt_foreign", traceId: "trc_other" }),
        makeEvent({ sequence: 3, id: "evt_orphan", branchId: "br_ghost" }),
      ],
    });
    expect(issuesOf(() => parseBundle(badEvents))).toEqual([
      "duplicate event id evt_dup",
      "event evt_foreign belongs to another trace",
      "event evt_orphan references missing branch br_ghost",
    ]);

    const nonMonotonic = makeBundle({
      events: [
        makeEvent({ sequence: 4, id: "evt_a" }),
        makeEvent({ sequence: 4, id: "evt_b" }),
        makeEvent({ sequence: 5, id: "evt_c" }),
      ],
    });
    const issues = issuesOf(() => parseBundle(nonMonotonic));
    expect(issues).toHaveLength(1);
    expect(must(issues[0])).toMatch(
      /^branch br_root: event evt_b has sequence 4 but previous sequence was 4/,
    );

    const badFork = makeBundle({ forks: [makeFork({ id: "frk_1", childBranchId: "br_nope" })] });
    expect(issuesOf(() => parseBundle(badFork))).toEqual([
      "fork frk_1 references unknown branches",
    ]);
  });

  it("accepts sequences that are unique per branch even if they repeat across branches", () => {
    const bundle = makeBundle({
      branches: [
        makeBranch({ id: "br_root" }),
        makeBranch({ id: "br_child", parentBranchId: "br_root", forkSequence: 0 }),
      ],
      events: [
        makeEvent({ sequence: 0, id: "evt_a" }),
        makeEvent({ sequence: 1, id: "evt_b" }),
        makeEvent({ sequence: 1, id: "evt_c", branchId: "br_child" }),
      ],
    });
    expect(() => parseBundle(bundle)).not.toThrow();
  });
});

describe("regenerateBundleIds", () => {
  const spec = must(demoTraces[0]);

  async function realBundle(): Promise<TraceExport> {
    const r = await recordScenario(spec);
    const child = await forkAndReplay({
      trace: r.trace,
      definition: spec.agent,
      parentBranch: r.root,
      parentLineage: r.result.events,
      existingBranches: [r.root],
      forkEventId: findEvent(r.result.events, "tool.request", "refund_order").id,
      overrides: must(spec.fork).overrides,
    });
    const comparison = compareBranches(
      { branch: r.root, events: r.result.events },
      { branch: child.branch, events: child.lineage },
    );
    const parsed = parseBundle(
      makeBundle({
        trace: r.trace,
        branches: [r.root, child.branch],
        forks: [child.fork],
        events: [...r.result.events, ...child.ownEvents],
      }),
    );
    return {
      ...parsed,
      replays: [
        {
          id: "rpl_1",
          traceId: r.trace.id,
          branchId: child.branch.id,
          forkId: child.fork.id,
          mode: "deterministic",
          status: "completed",
          startedAt: spec.startAt,
          completedAt: null,
          eventCount: child.replay.events.length,
          error: null,
          metadata: {},
        },
      ],
      comparisons: [
        {
          id: "cmp_1",
          traceId: r.trace.id,
          baseBranchId: r.root.id,
          targetBranchId: child.branch.id,
          createdAt: spec.startAt,
          result: comparison,
        },
      ],
    };
  }

  it("assigns fresh ids to every entity while preserving all references", async () => {
    const original = await realBundle();
    const regenerated = regenerateBundleIds(original, seededIdGenerator("regen"));

    // Still a valid bundle.
    expect(() => parseBundle(regenerated)).not.toThrow();

    const originalIds = new Set<string>([
      original.trace.id,
      ...original.branches.map((b) => b.id),
      ...original.forks.map((f) => f.id),
      ...original.replays.map((r) => r.id),
      ...original.comparisons.map((c) => c.id),
      ...original.events.map((e) => e.id),
      ...original.events
        .flatMap((e) => [e.spanId, e.parentSpanId])
        .filter((s): s is string => typeof s === "string"),
    ]);
    const regeneratedIds = [
      regenerated.trace.id,
      ...regenerated.branches.map((b) => b.id),
      ...regenerated.forks.map((f) => f.id),
      ...regenerated.replays.map((r) => r.id),
      ...regenerated.comparisons.map((c) => c.id),
      ...regenerated.events.map((e) => e.id),
      ...regenerated.events
        .flatMap((e) => [e.spanId, e.parentSpanId])
        .filter((s): s is string => typeof s === "string"),
    ];
    for (const id of regeneratedIds) expect(originalIds.has(id), id).toBe(false);
    expect(new Set(regenerated.events.map((e) => e.id)).size).toBe(original.events.length);
    expect(new Set(regenerated.branches.map((b) => b.id)).size).toBe(original.branches.length);

    // Trace and branches.
    expect(regenerated.trace.id).toMatch(/^trc_/);
    expect(regenerated.branches.map((b) => b.id)).toContain(regenerated.trace.rootBranchId);
    expect(regenerated.branches.every((b) => b.traceId === regenerated.trace.id)).toBe(true);
    const [root, child] = regenerated.branches;
    expect(must(root).parentBranchId).toBeNull();
    expect(must(child).parentBranchId).toBe(must(root).id);
    expect(must(child).forkId).toBe(must(regenerated.forks[0]).id);
    expect(must(child).forkEventId).toMatch(/^evt_/);
    expect(must(child).forkSequence).toBe(must(original.branches[1]).forkSequence);

    // Fork references.
    const fork = must(regenerated.forks[0]);
    expect(fork.traceId).toBe(regenerated.trace.id);
    expect(fork.parentBranchId).toBe(must(root).id);
    expect(fork.childBranchId).toBe(must(child).id);
    const forkEvent = regenerated.events.find((e) => e.id === fork.forkEventId);
    expect(forkEvent?.name).toBe("refund_order");
    expect(forkEvent?.branchId).toBe(must(root).id);
    expect(must(child).forkEventId).toBe(fork.forkEventId);

    // Replays and comparisons.
    expect(must(regenerated.replays[0])).toMatchObject({
      traceId: regenerated.trace.id,
      branchId: must(child).id,
      forkId: fork.id,
    });
    expect(must(regenerated.comparisons[0])).toMatchObject({
      traceId: regenerated.trace.id,
      baseBranchId: must(root).id,
      targetBranchId: must(child).id,
    });

    // Event relationships are preserved position by position.
    const byOldId = new Map(original.events.map((e, i) => [e.id, i]));
    const remap = new Map(original.events.map((e, i) => [e.id, must(regenerated.events[i]).id]));
    for (const [i, event] of regenerated.events.entries()) {
      const old = must(original.events[i]);
      expect(event.traceId).toBe(regenerated.trace.id);
      expect(event.sequence).toBe(old.sequence);
      expect(event.eventType).toBe(old.eventType);
      expect(event.branchId).toBe(
        old.branchId === must(original.branches[0]).id ? must(root).id : must(child).id,
      );
      if (old.parentEventId) {
        expect(byOldId.has(old.parentEventId)).toBe(true);
        expect(event.parentEventId).toBe(remap.get(old.parentEventId));
      } else {
        expect(event.parentEventId).toBeNull();
      }
      expect(event.spanId === null).toBe(old.spanId === null);
      expect(event.parentSpanId === null).toBe(old.parentSpanId === null);
      expect(event.input).toEqual(old.input);
    }
    // Span ids stay consistent across events.
    const spanPairs = new Map<string, string>();
    for (const [i, event] of regenerated.events.entries()) {
      const old = must(original.events[i]);
      for (const [oldSpan, newSpan] of [
        [old.spanId, event.spanId],
        [old.parentSpanId, event.parentSpanId],
      ] as const) {
        if (!oldSpan || !newSpan) continue;
        expect(spanPairs.get(oldSpan) ?? newSpan).toBe(newSpan);
        spanPairs.set(oldSpan, newSpan);
      }
    }
    // Metadata references to forks/replays are remapped too.
    const replayed = regenerated.events.filter((e) => e.eventType === "replay.started");
    expect(replayed).toHaveLength(1);
    expect((must(replayed[0]).metadata.shadow as { forkId?: string }).forkId).toBe(fork.id);
    const originalReplayId = (
      must(original.events.find((e) => e.eventType === "replay.started")).metadata.shadow as {
        replayId?: string;
      }
    ).replayId;
    expect(originalReplayId).toMatch(/^rpl_/);
    // The recorded replayId never appeared as an entity id in this bundle, so it is left alone.
    expect((must(replayed[0]).metadata.shadow as { replayId?: string }).replayId).toBe(
      originalReplayId,
    );
  });

  it("leaves non-shadow metadata untouched and uses random ids by default", () => {
    const bundle = parseBundle(
      makeBundle({
        events: [
          makeEvent({ sequence: 0, metadata: { plain: true } }),
          makeEvent({ sequence: 1, metadata: { shadow: "not-an-object" } }),
        ],
      }),
    );
    const regenerated = regenerateBundleIds(bundle);
    expect(must(regenerated.events[0]).metadata).toEqual({ plain: true });
    expect(must(regenerated.events[1]).metadata).toEqual({ shadow: "not-an-object" });
    expect(regenerated.trace.id).toMatch(/^trc_[0-9a-f]{32}$/);
    expect(regenerated.trace.id).not.toBe(bundle.trace.id);
  });

  it("is deterministic for a seeded generator", async () => {
    const bundle = await realBundle();
    const a = regenerateBundleIds(bundle, seededIdGenerator("same"));
    const b = regenerateBundleIds(bundle, seededIdGenerator("same"));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
