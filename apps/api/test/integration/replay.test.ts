import type {
  Branch,
  Comparison,
  DiffEntry,
  Fork,
  ReconstructedState,
  Replay,
  ShadowEvent,
  Trace,
  TraceSummary,
} from "@shadow/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestApp,
  findEvent,
  ingestEvent,
  ingestRefundScenario,
  json,
  listAllEvents,
  must,
  type ErrorEnvelope,
  type RefundScenario,
  type TestApp,
} from "../helpers.js";

interface TreeResponse {
  branchId: string;
  events: ShadowEvent[];
  nodes: { id: string; depth: number; childCount: number; spanDurationMs: number | null }[];
}

interface EventStateResponse {
  event: { id: string; sequence: number };
  branchId: string;
  before: ReconstructedState;
  after: ReconstructedState;
  stateDiff: DiffEntry[];
  contextDiff: DiffEntry[];
}

describe("fork, replay and comparison end-to-end", () => {
  let t: TestApp;
  let scenario: RefundScenario;
  let forkEvent: ShadowEvent;
  let branch: Branch;
  let fork: Fork;
  let replay: Replay;
  let comparison: Comparison;

  const getTrace = async () =>
    json<{ trace: TraceSummary; branches: Branch[] }>(
      await t.app.inject({ method: "GET", url: `/api/v1/traces/${scenario.traceId}` }),
    );

  beforeAll(async () => {
    t = await createTestApp();
    scenario = await ingestRefundScenario(t);
    forkEvent = findEvent(scenario.rootEvents, "tool.request", "refund_order");
  });

  afterAll(async () => {
    await t.close();
  });

  it("ingests the recorded root branch", async () => {
    expect(scenario.recorded.status).toBe("failed");
    expect(scenario.rootEvents).toHaveLength(scenario.recorded.events.length);
    expect(scenario.rootEvents.map((e) => e.id)).toEqual(scenario.recorded.events.map((e) => e.id));
    const { trace, branches } = await getTrace();
    expect(trace.status).toBe("failed");
    expect(trace.outcome?.kind).toBe("policy_violation");
    expect(trace.agentSlug).toBe("refund-agent");
    expect(trace.metrics.toolCalls).toBe(scenario.recorded.metrics.toolCalls);
    expect(trace.metrics.totalEstimatedCost).toBe(scenario.recorded.metrics.totalEstimatedCost);
    expect(trace.branchCount).toBe(1);
    expect(branches).toHaveLength(1);
    expect(branches[0]?.status).toBe("failed");
  });

  it("creates a pending fork before the refund tool call", async () => {
    const response = await t.app.inject({
      method: "POST",
      url: `/api/v1/traces/${scenario.traceId}/forks`,
      payload: {
        forkEventId: forkEvent.id,
        overrides: [
          { kind: "context", op: "set", key: "refundLimit", value: 100, label: "real limit" },
        ],
      },
    });
    expect(response.statusCode).toBe(201);
    ({ branch, fork } = json<{ branch: Branch; fork: Fork }>(response));
    expect(branch).toMatchObject({
      traceId: scenario.traceId,
      name: "fork-1",
      status: "pending",
      parentBranchId: scenario.rootBranchId,
      forkId: fork.id,
      forkEventId: forkEvent.id,
      forkSequence: forkEvent.sequence - 1,
      depth: 1,
      outcome: null,
    });
    expect(branch.id).toMatch(/^br_/);
    expect(fork).toMatchObject({
      traceId: scenario.traceId,
      parentBranchId: scenario.rootBranchId,
      childBranchId: branch.id,
      forkEventId: forkEvent.id,
      forkSequence: forkEvent.sequence - 1,
      overrides: [
        {
          id: "ovr_1",
          kind: "context",
          op: "set",
          key: "refundLimit",
          value: 100,
          label: "real limit",
        },
      ],
      metadata: { selectedEventId: forkEvent.id },
    });

    const branches = json<{ items: Branch[] }>(
      await t.app.inject({ method: "GET", url: `/api/v1/traces/${scenario.traceId}/branches` }),
    );
    expect(branches.items).toHaveLength(2);
    expect(branches.items.map((b) => b.name)).toEqual(["main", "fork-1"]);
    expect((await getTrace()).trace.branchCount).toBe(2);
    const forks = json<{ items: Fork[] }>(
      await t.app.inject({ method: "GET", url: `/api/v1/traces/${scenario.traceId}/forks` }),
    );
    expect(forks.items.map((f) => f.id)).toEqual([fork.id]);

    const own = await listAllEvents(t, scenario.traceId, { branchId: branch.id, inherited: false });
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({
      eventType: "fork.created",
      sequence: forkEvent.sequence,
      name: "fork-1",
    });
  });

  it("replays the fork deterministically to a different outcome", async () => {
    const response = await t.app.inject({
      method: "POST",
      url: `/api/v1/branches/${branch.id}/replay`,
    });
    expect(response.statusCode).toBe(201);
    const body = json<{ replay: Replay; branch: Branch }>(response);
    replay = body.replay;
    expect(replay).toMatchObject({
      traceId: scenario.traceId,
      branchId: branch.id,
      forkId: fork.id,
      mode: "deterministic",
      status: "completed",
      error: null,
    });
    expect(replay.eventCount).toBeGreaterThan(0);
    expect(replay.completedAt).not.toBeNull();
    expect(replay.metadata).toEqual({ agent: "refund-agent" });
    expect(body.branch.status).toBe("completed");
    expect(body.branch.outcome?.kind).toBe("approval_pending");
    expect(body.branch.metrics.eventCount).toBeGreaterThan(forkEvent.sequence);

    const own = await listAllEvents(t, scenario.traceId, { branchId: branch.id, inherited: false });
    expect(own).toHaveLength(replay.eventCount + 1);
    expect(own[0]?.eventType).toBe("fork.created");
    expect(own.map((e) => e.eventType)).toEqual(
      expect.arrayContaining([
        "replay.started",
        "replay.completed",
        "human.approval_requested",
        "trace.completed",
      ]),
    );
    for (let i = 1; i < own.length; i++)
      expect(own[i]?.sequence).toBeGreaterThan(own[i - 1]?.sequence ?? -1);
    expect(
      own.every((e) => e.branchId === branch.id && e.sequence > (branch.forkSequence ?? -1)),
    ).toBe(true);

    const replays = json<{ items: Replay[] }>(
      await t.app.inject({ method: "GET", url: `/api/v1/traces/${scenario.traceId}/replays` }),
    );
    expect(replays.items.map((r) => r.id)).toEqual([replay.id]);
    const stored = json<Branch>(
      await t.app.inject({ method: "GET", url: `/api/v1/branches/${branch.id}` }),
    );
    expect(stored.status).toBe("completed");
    expect(stored.outcome?.kind).toBe("approval_pending");
  });

  it("is idempotent when replayed again", async () => {
    const before = await listAllEvents(t, scenario.traceId, {
      branchId: branch.id,
      inherited: false,
    });
    const response = await t.app.inject({
      method: "POST",
      url: `/api/v1/branches/${branch.id}/replay`,
      payload: { mode: "deterministic" },
    });
    expect(response.statusCode).toBe(201);
    const body = json<{ replay: Replay; branch: Branch }>(response);
    expect(body.replay.status).toBe("completed");
    expect(body.replay.id).not.toBe(replay.id);
    expect(body.replay.eventCount).toBe(replay.eventCount);
    expect(body.branch.outcome?.kind).toBe("approval_pending");
    const after = await listAllEvents(t, scenario.traceId, {
      branchId: branch.id,
      inherited: false,
    });
    expect(after).toHaveLength(before.length);
    expect(new Set(after.map((e) => e.sequence)).size).toBe(after.length);
    expect(after.map((e) => e.sequence)).toEqual(before.map((e) => e.sequence));
    expect(after.map((e) => `${e.eventType} ${e.name}`)).toEqual(
      before.map((e) => `${e.eventType} ${e.name}`),
    );
    const replays = json<{ items: Replay[] }>(
      await t.app.inject({ method: "GET", url: `/api/v1/traces/${scenario.traceId}/replays` }),
    );
    expect(replays.items).toHaveLength(2);
    expect((await getTrace()).trace.branchCount).toBe(2);
  });

  it("compares the branches and finds the policy divergence", async () => {
    const response = await t.app.inject({
      method: "POST",
      url: "/api/v1/comparisons",
      payload: { baseBranchId: scenario.rootBranchId, targetBranchId: branch.id },
    });
    expect(response.statusCode).toBe(201);
    comparison = json<Comparison>(response);
    expect(comparison.id).toMatch(/^cmp_/);
    expect(comparison).toMatchObject({
      traceId: scenario.traceId,
      baseBranchId: scenario.rootBranchId,
      targetBranchId: branch.id,
    });
    const { result } = comparison;
    expect(result.sharedUntilSequence).toBe(branch.forkSequence);
    expect(result.overrides).toEqual(fork.overrides);
    const divergence = must(result.firstDivergence, "first divergence");
    expect(divergence.reason).toBe("output_changed");
    expect(divergence.base?.eventType).toBe("policy.evaluated");
    expect(divergence.target?.eventType).toBe("policy.evaluated");
    expect(divergence.base?.name).toBe("refund.autonomous_limit");
    expect(divergence.fields).toContainEqual({
      path: "output.decision",
      before: "allow",
      after: "approval_required",
    });
    expect(result.outcome.changed).toBe(true);
    expect(result.outcome.base?.kind).toBe("policy_violation");
    expect(result.outcome.target?.kind).toBe("approval_pending");
    expect(result.metrics.totalEstimatedCost.delta).toBeLessThan(0);
    expect(result.metrics.totalEstimatedCost.base).toBe(result.base.metrics.totalEstimatedCost);
    expect(result.policy.changed).toBe(true);
    expect(result.policy.base.allow).toBeGreaterThan(0);
    expect(result.policy.target.approval_required).toBeGreaterThan(0);
    expect(result.context.diff).toContainEqual({
      path: "/refundLimit",
      op: "changed",
      before: 500,
      after: 100,
    });
    expect(result.base.branchId).toBe(scenario.rootBranchId);
    expect(result.target.branchId).toBe(branch.id);
    expect(result.steps.length).toBeGreaterThan(0);
    expect(result.steps.filter((s) => s.kind === "shared")).toHaveLength(
      (branch.forkSequence ?? 0) + 1,
    );
  });

  it("lists and fetches comparisons", async () => {
    const list = json<{ items: Comparison[]; nextCursor: null }>(
      await t.app.inject({ method: "GET", url: `/api/v1/comparisons?traceId=${scenario.traceId}` }),
    );
    expect(list.items.map((c) => c.id)).toEqual([comparison.id]);
    expect(list.nextCursor).toBeNull();
    const byBranch = json<{ items: Comparison[] }>(
      await t.app.inject({ method: "GET", url: `/api/v1/comparisons?branchId=${branch.id}` }),
    );
    expect(byBranch.items.map((c) => c.id)).toEqual([comparison.id]);
    expect(
      json<{ items: Comparison[] }>(
        await t.app.inject({ method: "GET", url: "/api/v1/comparisons?traceId=trc_other" }),
      ).items,
    ).toEqual([]);

    const single = await t.app.inject({
      method: "GET",
      url: `/api/v1/comparisons/${comparison.id}`,
    });
    expect(single.statusCode).toBe(200);
    expect(json<Comparison>(single)).toEqual(comparison);
    expect(
      (await t.app.inject({ method: "GET", url: "/api/v1/comparisons/cmp_missing" })).statusCode,
    ).toBe(404);
  });

  it("rejects comparisons of the same branch, unknown branches and different traces", async () => {
    const same = await t.app.inject({
      method: "POST",
      url: "/api/v1/comparisons",
      payload: { baseBranchId: branch.id, targetBranchId: branch.id },
    });
    expect(same.statusCode).toBe(422);
    expect(json<ErrorEnvelope>(same).error.code).toBe("same_branch");
    const unknown = await t.app.inject({
      method: "POST",
      url: "/api/v1/comparisons",
      payload: { baseBranchId: branch.id, targetBranchId: "br_missing" },
    });
    expect(unknown.statusCode).toBe(404);
    const other = json<Trace>(
      await t.app.inject({
        method: "POST",
        url: "/api/v1/traces",
        payload: { project: "p", agent: "a", name: "other" },
      }),
    );
    const different = await t.app.inject({
      method: "POST",
      url: "/api/v1/comparisons",
      payload: { baseBranchId: scenario.rootBranchId, targetBranchId: other.rootBranchId },
    });
    expect(different.statusCode).toBe(422);
    expect(json<ErrorEnvelope>(different).error.code).toBe("different_traces");
  });

  it("serves the effective lineage of the fork", async () => {
    const lineage = await listAllEvents(t, scenario.traceId, { branchId: branch.id });
    const own = await listAllEvents(t, scenario.traceId, { branchId: branch.id, inherited: false });
    const prefixLength = (branch.forkSequence ?? -1) + 1;
    expect(lineage).toHaveLength(prefixLength + own.length);
    expect(lineage.slice(0, prefixLength).map((e) => e.id)).toEqual(
      scenario.rootEvents.slice(0, prefixLength).map((e) => e.id),
    );
    expect(lineage[prefixLength]?.eventType).toBe("fork.created");
    expect(lineage.slice(prefixLength).map((e) => e.id)).toEqual(own.map((e) => e.id));
    for (let i = 1; i < lineage.length; i++)
      expect(lineage[i]?.sequence).toBeGreaterThan(lineage[i - 1]?.sequence ?? -1);
    expect(lineage.some((e) => e.id === forkEvent.id)).toBe(false);

    const viaBranch = await t.app.inject({
      method: "GET",
      url: `/api/v1/branches/${branch.id}/events?limit=1000`,
    });
    expect(json<{ items: ShadowEvent[] }>(viaBranch).items.map((e) => e.id)).toEqual(
      lineage.map((e) => e.id),
    );
  });

  it("reconstructs state on both branches", async () => {
    const root = json<ReconstructedState>(
      await t.app.inject({ method: "GET", url: `/api/v1/branches/${scenario.rootBranchId}/state` }),
    );
    expect(root.context.refundLimit).toBe(500);
    expect(root.state.step).toBe("done");
    const forked = json<ReconstructedState>(
      await t.app.inject({ method: "GET", url: `/api/v1/branches/${branch.id}/state` }),
    );
    expect(forked.context.refundLimit).toBe(100);
    expect(forked.context.customerId).toBe("cus_1001");
    expect(forked.state.step).toBe("done");
    expect(forked.state.approval).toMatchObject({ status: "pending" });
    const atFork = json<ReconstructedState>(
      await t.app.inject({
        method: "GET",
        url: `/api/v1/branches/${branch.id}/state?sequence=${branch.forkSequence ?? 0}`,
      }),
    );
    expect(atFork.context.refundLimit).toBe(500);
    expect(atFork.fromSnapshotSequence).not.toBeNull();
  });

  it("returns before/after state with diffs for an event", async () => {
    const contextEvent = must(
      scenario.rootEvents.find(
        (e) =>
          e.eventType === "context.added" && (e.output as { key?: string })?.key === "refundLimit",
      ),
      "refundLimit context.added",
    );
    const response = await t.app.inject({
      method: "GET",
      url: `/api/v1/traces/${scenario.traceId}/events/${contextEvent.id}/state?branchId=${scenario.rootBranchId}`,
    });
    expect(response.statusCode).toBe(200);
    const body = json<EventStateResponse>(response);
    expect(body.event).toEqual({ id: contextEvent.id, sequence: contextEvent.sequence });
    expect(body.branchId).toBe(scenario.rootBranchId);
    expect(body.before.context.refundLimit).toBeUndefined();
    expect(body.after.context.refundLimit).toBe(500);
    expect(body.before.asOfSequence).toBeLessThan(contextEvent.sequence);
    expect(body.after.asOfSequence).toBe(contextEvent.sequence);
    expect(body.contextDiff).toEqual([{ path: "/refundLimit", op: "added", after: 500 }]);
    expect(body.stateDiff).toEqual([]);

    const patchEvent = findEvent(scenario.rootEvents, "state.patch");
    const patched = json<EventStateResponse>(
      await t.app.inject({
        method: "GET",
        url: `/api/v1/traces/${scenario.traceId}/events/${patchEvent.id}/state`,
      }),
    );
    expect(patched.branchId).toBe(scenario.rootBranchId);
    expect(patched.stateDiff.length).toBeGreaterThan(0);

    const fromFork = json<EventStateResponse>(
      await t.app.inject({
        method: "GET",
        url: `/api/v1/traces/${scenario.traceId}/events/${contextEvent.id}/state?branchId=${branch.id}`,
      }),
    );
    expect(fromFork.branchId).toBe(branch.id);
    expect(fromFork.after.context.refundLimit).toBe(500);
    expect(
      (
        await t.app.inject({
          method: "GET",
          url: `/api/v1/traces/${scenario.traceId}/events/evt_missing/state`,
        })
      ).statusCode,
    ).toBe(404);
  });

  it("returns the execution tree with depths", async () => {
    const response = await t.app.inject({
      method: "GET",
      url: `/api/v1/traces/${scenario.traceId}/tree`,
    });
    expect(response.statusCode).toBe(200);
    const tree = json<TreeResponse>(response);
    expect(tree.branchId).toBe(scenario.rootBranchId);
    expect(tree.events).toHaveLength(scenario.rootEvents.length);
    expect(tree.nodes).toHaveLength(scenario.rootEvents.length);
    const depth = new Map(tree.nodes.map((n) => [n.id, n]));
    const request = must(depth.get(forkEvent.id));
    const responseEvent = findEvent(scenario.rootEvents, "tool.response", "refund_order");
    expect(must(depth.get(responseEvent.id)).depth).toBe(request.depth + 1);
    expect(request.childCount).toBeGreaterThanOrEqual(1);
    expect(request.spanDurationMs).not.toBeNull();
    expect(must(depth.get(findEvent(scenario.rootEvents, "trace.started").id)).depth).toBe(0);
    const agentStarted = must(depth.get(findEvent(scenario.rootEvents, "agent.started").id));
    expect(request.depth).toBe(agentStarted.depth + 1);

    const forkTree = json<TreeResponse>(
      await t.app.inject({
        method: "GET",
        url: `/api/v1/traces/${scenario.traceId}/tree?branchId=${branch.id}`,
      }),
    );
    const lineage = await listAllEvents(t, scenario.traceId, { branchId: branch.id });
    expect(forkTree.branchId).toBe(branch.id);
    expect(forkTree.events.map((e) => e.id)).toEqual(lineage.map((e) => e.id));
    expect(
      (
        await t.app.inject({
          method: "GET",
          url: `/api/v1/traces/${scenario.traceId}/tree?branchId=br_missing`,
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe("fork and replay error cases", () => {
  let t: TestApp;
  let scenario: RefundScenario;
  let firstFork: Branch;

  beforeAll(async () => {
    t = await createTestApp();
    scenario = await ingestRefundScenario(t, "trc_test_refund_errors", { seed: "t2" });
    const response = await t.app.inject({
      method: "POST",
      url: `/api/v1/traces/${scenario.traceId}/forks`,
      payload: {
        forkEventId: findEvent(scenario.rootEvents, "tool.request", "refund_order").id,
        overrides: [],
      },
    });
    if (response.statusCode !== 201) throw new Error(response.body);
    firstFork = json<{ branch: Branch }>(response).branch;
  });

  afterAll(async () => {
    await t.close();
  });

  it("returns 404 for unknown fork events and traces", async () => {
    const unknownEvent = await t.app.inject({
      method: "POST",
      url: `/api/v1/traces/${scenario.traceId}/forks`,
      payload: { forkEventId: "evt_missing" },
    });
    expect(unknownEvent.statusCode).toBe(404);
    expect(json<ErrorEnvelope>(unknownEvent).error.details).toEqual({
      resource: "event",
      id: "evt_missing",
    });
    const unknownTrace = await t.app.inject({
      method: "POST",
      url: "/api/v1/traces/trc_missing/forks",
      payload: { forkEventId: "evt_x" },
    });
    expect(unknownTrace.statusCode).toBe(404);
    const invalid = await t.app.inject({
      method: "POST",
      url: `/api/v1/traces/${scenario.traceId}/forks`,
      payload: { overrides: [] },
    });
    expect(invalid.statusCode).toBe(400);
    const badOverride = await t.app.inject({
      method: "POST",
      url: `/api/v1/traces/${scenario.traceId}/forks`,
      payload: { forkEventId: "evt_x", overrides: [{ kind: "teleport" }] },
    });
    expect(badOverride.statusCode).toBe(400);
  });

  it("refuses to fork from replay bookkeeping events", async () => {
    const [forkCreated] = await listAllEvents(t, scenario.traceId, {
      branchId: firstFork.id,
      inherited: false,
    });
    expect(forkCreated?.eventType).toBe("fork.created");
    const response = await t.app.inject({
      method: "POST",
      url: `/api/v1/traces/${scenario.traceId}/forks`,
      payload: { forkEventId: forkCreated?.id ?? "" },
    });
    expect(response.statusCode).toBe(422);
    const body = json<ErrorEnvelope>(response);
    expect(body.error.code).toBe("not_forkable");
    expect(body.error.message).toContain("fork.created");
  });

  it("rejects duplicate branch names", async () => {
    const response = await t.app.inject({
      method: "POST",
      url: `/api/v1/traces/${scenario.traceId}/forks`,
      payload: {
        forkEventId: findEvent(scenario.rootEvents, "tool.request", "read_policy").id,
        name: "fork-1",
      },
    });
    expect(response.statusCode).toBe(409);
    const body = json<ErrorEnvelope>(response);
    expect(body.error.code).toBe("conflict");
    expect(body.error.details).toEqual({ name: "fork-1" });
    const branches = json<{ items: Branch[] }>(
      await t.app.inject({ method: "GET", url: `/api/v1/traces/${scenario.traceId}/branches` }),
    );
    expect(branches.items).toHaveLength(2);
  });

  it("rejects a parent branch from another trace", async () => {
    const other = json<Trace>(
      await t.app.inject({
        method: "POST",
        url: "/api/v1/traces",
        payload: { project: "p", agent: "a", name: "other" },
      }),
    );
    const response = await t.app.inject({
      method: "POST",
      url: `/api/v1/traces/${scenario.traceId}/forks`,
      payload: {
        forkEventId: findEvent(scenario.rootEvents, "tool.request", "read_policy").id,
        parentBranchId: other.rootBranchId,
      },
    });
    expect(response.statusCode).toBe(400);
    expect(json<ErrorEnvelope>(response).error.code).toBe("bad_request");
  });

  it("refuses to replay the root branch", async () => {
    const response = await t.app.inject({
      method: "POST",
      url: `/api/v1/branches/${scenario.rootBranchId}/replay`,
    });
    expect(response.statusCode).toBe(422);
    expect(json<ErrorEnvelope>(response).error.code).toBe("not_forked");
    expect(
      (await t.app.inject({ method: "POST", url: "/api/v1/branches/br_missing/replay" }))
        .statusCode,
    ).toBe(404);
  });

  it("rejects live and historical modes", async () => {
    const live = await t.app.inject({
      method: "POST",
      url: `/api/v1/branches/${firstFork.id}/replay`,
      payload: { mode: "live" },
    });
    expect(live.statusCode).toBe(501);
    expect(json<ErrorEnvelope>(live).error.code).toBe("live_replay_disabled");
    const historical = await t.app.inject({
      method: "POST",
      url: `/api/v1/branches/${firstFork.id}/replay`,
      payload: { mode: "historical" },
    });
    expect(historical.statusCode).toBe(422);
    expect(json<ErrorEnvelope>(historical).error.code).toBe("unsupported_mode");
    const bogus = await t.app.inject({
      method: "POST",
      url: `/api/v1/branches/${firstFork.id}/replay`,
      payload: { mode: "bogus" },
    });
    expect(bogus.statusCode).toBe(400);
    const branch = json<Branch>(
      await t.app.inject({ method: "GET", url: `/api/v1/branches/${firstFork.id}` }),
    );
    expect(branch.status).toBe("pending");
  });

  it("rejects replay for agents without a registered program", async () => {
    const trace = json<Trace>(
      await t.app.inject({
        method: "POST",
        url: "/api/v1/traces",
        payload: { project: "support-agent", agent: "custom-agent", name: "custom" },
      }),
    );
    const ingested = await t.app.inject({
      method: "POST",
      url: `/api/v1/traces/${trace.id}/events`,
      payload: {
        events: [
          ingestEvent("trace.started", "custom"),
          ingestEvent("tool.request", "lookup", { input: { tool: "lookup", arguments: {} } }),
          ingestEvent("tool.response", "lookup", { output: { result: 1 } }),
          ingestEvent("trace.completed", "trace.completed", {
            output: { outcome: { kind: "completed", label: "Done" } },
          }),
        ],
      },
    });
    expect(ingested.statusCode).toBe(201);
    const events = await listAllEvents(t, trace.id);
    const forked = await t.app.inject({
      method: "POST",
      url: `/api/v1/traces/${trace.id}/forks`,
      payload: {
        forkEventId: findEvent(events, "tool.request", "lookup").id,
        overrides: [{ kind: "tool_result", tool: "lookup", result: 2 }],
      },
    });
    expect(forked.statusCode).toBe(201);
    const { branch } = json<{ branch: Branch }>(forked);
    const replay = await t.app.inject({
      method: "POST",
      url: `/api/v1/branches/${branch.id}/replay`,
    });
    expect(replay.statusCode).toBe(422);
    const body = json<ErrorEnvelope>(replay);
    expect(body.error.code).toBe("agent_not_replayable");
    expect(body.error.details).toMatchObject({ agent: "custom-agent" });
    expect((body.error.details as { replayable: string[] }).replayable).toContain("refund-agent");
    expect(
      json<Branch>(await t.app.inject({ method: "GET", url: `/api/v1/branches/${branch.id}` }))
        .status,
    ).toBe("pending");
  });
});
