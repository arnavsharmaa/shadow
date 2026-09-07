/**
 * Large-trace benchmark: records a ~10k event synthetic trace and times the
 * core engine's hot paths. Run with `pnpm --filter @shadow/core bench`.
 *
 * Timings are printed, never asserted, so this can run anywhere without
 * being flaky.
 */
import type { Branch, Trace } from "@shadow/schemas";
import { emptyBranchMetrics } from "@shadow/schemas";
import {
  VirtualClock,
  assertStrictlyIncreasing,
  buildEventTree,
  compareBranches,
  createFork,
  createReplay,
  effectiveEvents,
  executeReplay,
  reconstructState,
  recordExecution,
  seededIdGenerator,
  sortEvents,
  type AgentDefinition,
} from "../src/index.js";
import { syntheticAgentDefinition } from "../../testkit/src/index.js";

// The synthetic agent emits ~6 events per iteration.
const ITERATIONS = Number(process.env.SHADOW_BENCH_ITERATIONS ?? 1_700);
const TRACE_ID = "trc_bench";
const ROOT_BRANCH_ID = "br_bench_main";
const START_AT = "2026-09-01T00:00:00.000Z";

interface Row {
  step: string;
  ms: number;
  note: string;
}

const rows: Row[] = [];

async function timed<T>(
  step: string,
  fn: () => Promise<T> | T,
  note: (value: T) => string = () => "",
): Promise<T> {
  const started = performance.now();
  const value = await fn();
  rows.push({ step, ms: performance.now() - started, note: note(value) });
  return value;
}

function printTable(): void {
  const stepWidth = Math.max(...rows.map((r) => r.step.length), 4);
  const line = (step: string, ms: string, note: string) =>
    `${step.padEnd(stepWidth)}  ${ms.padStart(10)}  ${note}`;
  console.log("");
  console.log(line("step", "ms", "notes"));
  console.log(line("-".repeat(stepWidth), "-".repeat(10), "-".repeat(30)));
  for (const row of rows) console.log(line(row.step, row.ms.toFixed(1), row.note));
  console.log("");
}

async function main(): Promise<void> {
  console.log(`Shadow core benchmark — synthetic agent, ${ITERATIONS} iterations`);

  const recorded = await timed(
    "recordExecution",
    () =>
      recordExecution({
        definition: syntheticAgentDefinition,
        input: { iterations: ITERATIONS },
        traceId: TRACE_ID,
        branchId: ROOT_BRANCH_ID,
        traceName: "synthetic benchmark",
        seed: "bench",
        startAt: START_AT,
      }),
    (r) =>
      `${r.events.length} events, ${r.events.filter((e) => e.eventType === "state.snapshot").length} snapshots`,
  );
  const events = recorded.events;

  await timed("sortEvents + assertStrictlyIncreasing", () => {
    const sorted = sortEvents(events);
    assertStrictlyIncreasing(sorted);
    return sorted;
  });

  await timed(
    "reconstructState (with snapshots)",
    () => reconstructState(events),
    (s) => `applied ${s.appliedEvents} events from snapshot @${s.fromSnapshotSequence ?? "none"}`,
  );
  await timed(
    "reconstructState (without snapshots)",
    () => reconstructState(events, { useSnapshots: false }),
    (s) => `applied ${s.appliedEvents} events`,
  );

  await timed(
    "buildEventTree",
    () => buildEventTree(events),
    (tree) => `${tree.length} roots`,
  );

  const now = START_AT;
  const root: Branch = {
    id: ROOT_BRANCH_ID,
    traceId: TRACE_ID,
    name: "main",
    parentBranchId: null,
    forkId: null,
    forkEventId: null,
    forkSequence: null,
    depth: 0,
    status: "completed",
    outcome: recorded.outcome,
    metrics: recorded.metrics,
    createdAt: now,
    updatedAt: now,
    metadata: {},
  };
  const trace: Trace = {
    id: TRACE_ID,
    projectId: "prj_bench",
    agentId: "agt_bench",
    rootBranchId: ROOT_BRANCH_ID,
    name: "synthetic benchmark",
    status: "completed",
    schemaVersion: "1.0",
    startedAt: now,
    completedAt: null,
    durationMs: null,
    outcome: recorded.outcome,
    tags: [],
    metadata: {},
    metrics: emptyBranchMetrics(),
    branchCount: 1,
    createdAt: now,
    updatedAt: now,
  };

  let occurrence = 0;
  const midpoint = events.find(
    (e) => e.eventType === "tool.request" && ++occurrence === Math.floor(ITERATIONS / 2),
  );
  if (!midpoint) throw new Error("midpoint tool request not found");

  const child = await timed(
    "createFork + executeReplay (midpoint, 1 tool_result override)",
    async () => {
      const forked = createFork({
        trace,
        parentBranch: root,
        lineage: events,
        existingBranches: [root],
        forkEventId: midpoint.id,
        overrides: [
          {
            id: "ovr_1",
            kind: "tool_result",
            tool: "compute",
            occurrence: 1,
            result: { value: 1_000_000 },
          },
        ],
        ids: seededIdGenerator("bench-fork"),
        clock: new VirtualClock(START_AT),
      });
      const plan = createReplay({
        trace,
        branch: forked.branch,
        fork: forked.fork,
        parentLineage: events,
        existingBranchEvents: forked.events,
      });
      const replay = await executeReplay(
        plan,
        syntheticAgentDefinition as unknown as AgentDefinition,
      );
      const branch: Branch = {
        ...forked.branch,
        status: replay.branchStatus,
        outcome: replay.outcome,
        metrics: replay.metrics,
      };
      const own = [...forked.events, ...replay.events];
      const lineage = effectiveEvents([root, branch], branch.id, (id) =>
        id === branch.id ? own : events,
      );
      return { branch, lineage, replay, overrides: forked.fork.overrides };
    },
    (c) =>
      `${c.replay.status}, ${c.replay.events.length} replayed events (fork @${c.branch.forkSequence})`,
  );

  await timed(
    "compareBranches",
    () =>
      compareBranches(
        { branch: root, events },
        { branch: child.branch, events: child.lineage },
        { overrides: child.overrides },
      ),
    (c) => `${c.steps.length} steps, first divergence @${c.firstDivergence?.sequence ?? "none"}`,
  );

  printTable();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
