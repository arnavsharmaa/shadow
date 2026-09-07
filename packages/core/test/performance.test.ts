import { describe, expect, it } from "vitest";
import {
  assertStrictlyIncreasing,
  buildEventTree,
  compareBranches,
  reconstructState,
  sortEvents,
} from "../src/index.js";
import {
  findEvent,
  forkAndReplay,
  must,
  ofType,
  recordDefinition,
  syntheticAgentDefinition,
} from "./helpers.js";

// ~6 events per iteration → roughly 10k events.
const ITERATIONS = 1_700;
// Deliberately generous: this guards against pathological slowdowns, not micro-regressions.
const CEILING_MS = 20_000;

describe("large trace performance", () => {
  it(
    "reconstructs and compares a ~10k event trace within a generous ceiling",
    async () => {
      const started = performance.now();
      const recorded = await recordDefinition(
        syntheticAgentDefinition,
        { iterations: ITERATIONS },
        { traceId: "trc_perf", branchId: "br_perf" },
      );
      const events = recorded.result.events;
      expect(events.length).toBeGreaterThan(9_000);
      expect(recorded.result.status).toBe("completed");

      sortEvents(events);
      assertStrictlyIncreasing(events);
      const withSnapshots = reconstructState(events);
      const withoutSnapshots = reconstructState(events, { useSnapshots: false });
      expect(withSnapshots.state).toEqual(withoutSnapshots.state);
      expect(withSnapshots.context).toEqual(withoutSnapshots.context);
      expect(ofType(events, "state.snapshot").length).toBeGreaterThan(0);
      expect(withSnapshots.fromSnapshotSequence).not.toBeNull();
      expect(withSnapshots.appliedEvents).toBeLessThan(withoutSnapshots.appliedEvents);
      expect(withoutSnapshots.appliedEvents).toBeGreaterThan(ITERATIONS * 2);
      expect(withSnapshots.state.lastIteration).toBe(ITERATIONS - 1);

      const tree = buildEventTree(events);
      expect(tree.length).toBeGreaterThan(0);

      const midpoint = findEvent(events, "tool.request", "compute", Math.floor(ITERATIONS / 2));
      const child = await forkAndReplay({
        trace: recorded.trace,
        definition: recorded.spec.agent,
        parentBranch: recorded.root,
        parentLineage: events,
        existingBranches: [recorded.root],
        forkEventId: midpoint.id,
        overrides: [
          { kind: "tool_result", tool: "compute", occurrence: 1, result: { value: 1_000_000 } },
        ],
      });
      expect(child.replay.status).toBe("completed");
      expect(child.replay.error).toBeNull();

      const comparison = compareBranches(
        { branch: recorded.root, events },
        { branch: child.branch, events: child.lineage },
        { overrides: child.fork.overrides },
      );
      expect(comparison.sharedUntilSequence).toBe(must(child.branch.forkSequence));
      // The overridden tool.response is part of the execution: it aligns with
      // the recorded response as a modified step whose output changed.
      expect(
        comparison.steps.some(
          (s) => s.kind === "override" && s.target?.eventType === "tool.response",
        ),
      ).toBe(false);
      expect(comparison.firstDivergence?.reason).toBe("output_changed");
      expect(comparison.firstDivergence?.base).toMatchObject({
        eventType: "tool.response",
        name: "compute",
        sequence: midpoint.sequence + 1,
      });
      expect(comparison.firstDivergence?.target).toMatchObject({
        eventType: "tool.response",
        name: "compute",
      });
      expect(comparison.state.diff.some((d) => d.path === "/total")).toBe(true);
      expect(comparison.steps.filter((s) => s.kind === "modified").length).toBeGreaterThan(
        ITERATIONS / 4,
      );

      const elapsed = performance.now() - started;
      expect(elapsed).toBeLessThan(CEILING_MS);
    },
    CEILING_MS + 10_000,
  );
});
