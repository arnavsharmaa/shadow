import type { Override } from "@shadow/schemas";
import { describe, expect, it } from "vitest";
import {
  ReplayError,
  VirtualClock,
  assertStrictlyIncreasing,
  createReplay,
  executeReplay,
  findAgentInput,
  reconstructState,
  seededIdGenerator,
  type AgentDefinition,
} from "../src/index.js";
import {
  LEDGER_INPUT,
  asObject,
  demoTraces,
  findEvent,
  forkAndReplay,
  ledgerAgentDefinition,
  ledgerArgumentsVariantDefinition,
  ledgerVariantDefinition,
  makeBranch,
  makeFork,
  makeTrace,
  must,
  ofType,
  recordDefinition,
  recordScenario,
  type Recorded,
} from "./helpers.js";

const refundSpec = must(demoTraces[0]);
const inventorySpec = must(demoTraces[1]);
const accessSpec = must(demoTraces[4]);

const ledger = (definition = ledgerAgentDefinition) => definition as unknown as AgentDefinition;

async function forkLedger(
  recorded: Recorded,
  forkName: string,
  overrides: Override[],
  extra: { definition?: AgentDefinition; inheritedOverrides?: Override[] } = {},
) {
  return forkAndReplay({
    trace: recorded.trace,
    definition: extra.definition ?? ledger(),
    parentBranch: recorded.root,
    parentLineage: recorded.result.events,
    existingBranches: [recorded.root],
    forkEventId: findEvent(recorded.result.events, "tool.request", forkName).id,
    overrides,
    inheritedOverrides: extra.inheritedOverrides,
  });
}

describe("refund counterfactual (context override)", () => {
  const recorded = recordScenario(refundSpec);
  const forked = recorded.then((r) =>
    forkAndReplay({
      trace: r.trace,
      definition: refundSpec.agent,
      parentBranch: r.root,
      parentLineage: r.result.events,
      existingBranches: [r.root],
      forkEventId: findEvent(r.result.events, "tool.request", "refund_order").id,
      overrides: must(refundSpec.fork).overrides,
      name: "fork-1",
    }),
  );

  it("turns the policy violation into a pending approval", async () => {
    const { result } = await recorded;
    const child = await forked;
    expect(result.outcome?.kind).toBe("policy_violation");
    expect(child.replay.status).toBe("completed");
    expect(child.replay.branchStatus).toBe("completed");
    expect(child.replay.error).toBeNull();
    expect(child.replay.outcome?.kind).toBe("approval_pending");
    expect(child.branch.status).toBe("completed");
    expect(child.branch.outcome?.kind).toBe("approval_pending");
    expect(ofType(child.replay.events, "policy.approval_required")).toHaveLength(1);
    expect(ofType(child.replay.events, "human.approval_requested")).toHaveLength(1);
    expect(ofType(child.replay.events, "policy.denied")).toHaveLength(0);
    expect(ofType(child.replay.events, "tool.response").map((e) => e.name)).toEqual(["send_email"]);
  });

  it("lays out bookkeeping, override and program events with continuous sequences", async () => {
    const child = await forked;
    const forkSequence = must(child.branch.forkSequence);
    const forkCreated = must(child.ownEvents[0]);
    expect(forkCreated.eventType).toBe("fork.created");
    expect(forkCreated.sequence).toBe(forkSequence + 1);

    const [started, override, first] = child.replay.events;
    expect(must(started)).toMatchObject({
      eventType: "replay.started",
      name: "deterministic",
      sequence: forkSequence + 2,
    });
    expect(asObject(must(started).input)).toMatchObject({
      mode: "deterministic",
      forkId: child.fork.id,
      forkSequence,
    });
    expect(must(override)).toMatchObject({
      eventType: "context.added",
      name: "refundLimit",
      output: { key: "refundLimit", value: 100 },
      tags: ["override"],
    });
    expect(must(override).metadata.shadow).toMatchObject({
      origin: "override",
      overrideKind: "context",
      overrideId: "ovr_1",
      forkId: child.fork.id,
    });
    expect(must(first)).toMatchObject({ eventType: "tool.request", name: "refund_order" });

    const tail = child.replay.events.slice(-3).map((e) => e.eventType);
    expect(tail).toEqual(["agent.completed", "trace.completed", "replay.completed"]);
    const completed = must(child.replay.events.at(-1));
    expect(asObject(completed.output)).toMatchObject({
      status: "completed",
      eventCount: child.replay.events.length,
    });
    expect(completed.durationMs).toBeGreaterThan(0);

    expect(() => assertStrictlyIncreasing(child.lineage)).not.toThrow();
    expect(child.lineage.map((e) => e.sequence)).toEqual(child.lineage.map((_, i) => i));
    for (const event of child.replay.events) {
      expect(event.source).toBe("replay");
      expect(event.branchId).toBe(child.branch.id);
      expect(event.metadata.shadow).toMatchObject({
        replayId: child.replay.replayId,
        forkId: child.fork.id,
        scenario: "refund-agent",
      });
      expect(["replay", "override"]).toContain(asObject(event.metadata.shadow).origin);
    }
    expect(child.replay.replayId).toMatch(/^rpl_/);
    // Replay time starts at the fork event's timestamp.
    const { result } = await recorded;
    expect(must(started).timestamp).toBe(
      findEvent(result.events, "tool.request", "refund_order").timestamp,
    );
  });

  it("aggregates metrics over the whole effective lineage", async () => {
    const child = await forked;
    expect(child.replay.metrics.eventCount).toBe(child.lineage.length);
    expect(child.replay.metrics.toolCalls).toBe(6);
    expect(child.replay.metrics.modelCalls).toBe(4);
    const { result } = await recorded;
    expect(child.replay.metrics.totalEstimatedCost).toBeLessThan(result.metrics.totalEstimatedCost);
    expect(child.replay.metrics.durationMs).toBeLessThan(result.metrics.durationMs);
  });

  it("is deterministic: replaying the same fork twice yields identical events", async () => {
    const r = await recorded;
    const run = () =>
      forkAndReplay({
        trace: r.trace,
        definition: refundSpec.agent,
        parentBranch: r.root,
        parentLineage: r.result.events,
        existingBranches: [r.root],
        forkEventId: findEvent(r.result.events, "tool.request", "refund_order").id,
        overrides: must(refundSpec.fork).overrides,
      });
    const [a, b] = await Promise.all([run(), run()]);
    expect(JSON.stringify(a.replay.events)).toBe(JSON.stringify(b.replay.events));
    expect(a.branch.id).toBe(b.branch.id);
  });

  it("supports a grandchild fork that inherits the parent's override through the recorded history", async () => {
    const r = await recorded;
    const child = await forked;
    const grandchild = await forkAndReplay({
      trace: r.trace,
      definition: refundSpec.agent,
      parentBranch: child.branch,
      parentLineage: child.lineage,
      existingBranches: [r.root, child.branch],
      forkEventId: findEvent(child.lineage, "tool.request", "send_email").id,
      overrides: [
        {
          id: "ovr_mail",
          kind: "tool_result",
          tool: "send_email",
          occurrence: 1,
          result: { messageId: "msg_override", status: "queued" },
        },
      ],
      name: "fork-2",
      seed: "grandchild",
    });
    expect(grandchild.replay.status).toBe("completed");
    expect(grandchild.replay.error).toBeNull();
    expect(grandchild.branch.depth).toBe(2);
    expect(grandchild.branch.parentBranchId).toBe(child.branch.id);
    // The parent's context override is part of the inherited prefix.
    expect(
      grandchild.lineage.some(
        (e) =>
          e.eventType === "context.added" &&
          e.name === "refundLimit" &&
          asObject(e.metadata.shadow).origin === "override",
      ),
    ).toBe(true);
    expect(reconstructState(grandchild.lineage).context.refundLimit).toBe(100);
    // ... and its effect carries through: still no violation, and the mail override is visible.
    expect(grandchild.replay.outcome?.kind).toBe("approval_pending");
    const mail = findEvent(grandchild.replay.events, "tool.response", "send_email");
    expect(mail.output).toEqual({ result: { messageId: "msg_override", status: "queued" } });
    expect(mail.metadata.shadow).toMatchObject({
      origin: "replay",
      overrideApplied: true,
      overrideKind: "tool_result",
      overrideId: "ovr_mail",
    });
    expect(ofType(grandchild.replay.events, "tool.request").map((e) => e.name)).toEqual([
      "send_email",
    ]);
    expect(reconstructState(grandchild.lineage).state.email).toEqual({
      messageId: "msg_override",
      status: "queued",
    });
  });

  it("changes the decision through a policy override instead of a context override", async () => {
    const r = await recorded;
    const child = await forkAndReplay({
      trace: r.trace,
      definition: refundSpec.agent,
      parentBranch: r.root,
      parentLineage: r.result.events,
      existingBranches: [r.root],
      forkEventId: findEvent(r.result.events, "tool.request", "refund_order").id,
      overrides: [
        {
          id: "ovr_policy",
          kind: "policy",
          policy: "refund.autonomous_limit",
          config: { limit: 100 },
        },
      ],
    });
    expect(child.replay.outcome?.kind).toBe("approval_pending");
    const evaluated = findEvent(child.replay.events, "policy.evaluated", "refund.autonomous_limit");
    expect(asObject(evaluated.output).decision).toBe("approval_required");
    expect(asObject(asObject(evaluated.output).details)).toMatchObject({
      limit: 100,
      source: "policy_config",
    });
    expect(asObject(evaluated.input).config).toEqual({ limit: 100 });
    expect(evaluated.metadata.shadow).toMatchObject({ overrideKind: "policy", origin: "replay" });
    // No state/context override events are written for policy overrides.
    expect(
      child.replay.events.filter((e) => asObject(e.metadata.shadow).origin === "override"),
    ).toHaveLength(0);
    // The stale context value is untouched.
    expect(reconstructState(child.lineage).context.refundLimit).toBe(500);
  });
});

describe("inventory counterfactual (tool_result override)", () => {
  const recorded = recordScenario(inventorySpec);

  it("replaces the first live inventory lookup and reserves stock", async () => {
    const r = await recorded;
    expect(r.result.outcome?.kind).toBe("incorrect_action");
    expect(ofType(r.result.events, "tool.error")).toHaveLength(3);
    const child = await forkAndReplay({
      trace: r.trace,
      definition: inventorySpec.agent,
      parentBranch: r.root,
      parentLineage: r.result.events,
      existingBranches: [r.root],
      forkEventId: findEvent(r.result.events, "tool.request", "inventory.lookup", 1).id,
      overrides: must(inventorySpec.fork).overrides,
    });
    expect(child.replay.status).toBe("completed");
    expect(child.replay.outcome?.kind).toBe("reserved");
    expect(ofType(child.replay.events, "tool.error")).toHaveLength(0);
    expect(ofType(child.lineage, "tool.error")).toHaveLength(0);
    expect(ofType(child.replay.events, "tool.request").map((e) => e.name)).toEqual([
      "inventory.lookup",
      "orders.reserve_stock",
    ]);
    const response = findEvent(child.replay.events, "tool.response", "inventory.lookup");
    expect(response.output).toEqual({
      result: must(
        must(inventorySpec.fork).overrides[0] as Extract<Override, { kind: "tool_result" }>,
      ).result,
    });
    expect(response.durationMs).toBe(0);
    expect(response.metadata.shadow).toMatchObject({
      origin: "replay",
      overrideApplied: true,
      overrideKind: "tool_result",
      overrideId: "ovr_1",
    });
    expect(child.replay.metrics.toolErrors).toBe(0);
  });

  it("targets the Nth live occurrence of the tool", async () => {
    const r = await recorded;
    const child = await forkAndReplay({
      trace: r.trace,
      definition: inventorySpec.agent,
      parentBranch: r.root,
      parentLineage: r.result.events,
      existingBranches: [r.root],
      forkEventId: findEvent(r.result.events, "tool.request", "inventory.lookup", 1).id,
      overrides: [
        {
          id: "ovr_3",
          kind: "tool_result",
          tool: "inventory.lookup",
          occurrence: 3,
          result: { sku: "SKU-7781", available: 50 },
        },
      ],
    });
    expect(child.replay.outcome?.kind).toBe("reserved");
    const lookups = child.replay.events.filter(
      (e) =>
        e.name === "inventory.lookup" &&
        (e.eventType === "tool.error" || e.eventType === "tool.response"),
    );
    expect(lookups.map((e) => e.eventType)).toEqual(["tool.error", "tool.error", "tool.response"]);
    expect(must(lookups[2]).metadata.shadow).toMatchObject({ overrideId: "ovr_3" });
  });

  it("serves recorded tool errors and notes from history when forking later", async () => {
    const r = await recorded;
    const child = await forkAndReplay({
      trace: r.trace,
      definition: inventorySpec.agent,
      parentBranch: r.root,
      parentLineage: r.result.events,
      existingBranches: [r.root],
      forkEventId: findEvent(r.result.events, "tool.request", "orders.create_backorder").id,
      overrides: [
        {
          kind: "tool_result",
          tool: "orders.create_backorder",
          occurrence: 1,
          result: { backorderId: "bo_override", status: "backordered" },
        },
      ],
    });
    expect(child.replay.status).toBe("completed");
    expect(child.replay.outcome?.kind).toBe("incorrect_action");
    expect(ofType(child.replay.events, "tool.error")).toHaveLength(0);
    expect(ofType(child.replay.events, "agent.note")).toHaveLength(0);
    expect(ofType(child.lineage, "tool.error")).toHaveLength(3);
    expect(reconstructState(child.lineage).state.result).toEqual({
      backorderId: "bo_override",
      status: "backordered",
    });
    expect(reconstructState(child.lineage).state.attempts).toBe(3);
  });
});

describe("access scenario (served approvals and policy blocks)", () => {
  it("replays the recorded approval and blocked tool from history", async () => {
    const r = await recordScenario(accessSpec);
    expect(r.result.outcome?.kind).toBe("granted");
    const child = await forkAndReplay({
      trace: r.trace,
      definition: accessSpec.agent,
      parentBranch: r.root,
      parentLineage: r.result.events,
      existingBranches: [r.root],
      forkEventId: findEvent(r.result.events, "tool.request", "notify_requester").id,
      overrides: [{ kind: "context", op: "set", key: "note", value: "replayed" }],
    });
    expect(child.replay.status).toBe("completed");
    expect(child.replay.outcome?.kind).toBe("granted");
    expect(ofType(child.replay.events, "human.approval_requested")).toHaveLength(0);
    expect(ofType(child.replay.events, "tool.request").map((e) => e.name)).toEqual([
      "notify_requester",
    ]);
    const state = reconstructState(child.lineage);
    expect(state.context.note).toBe("replayed");
    expect(asObject(state.state.approval).status).toBe("approved");
  });

  it("returns a pending approval from history when it was never resolved", async () => {
    const r = await recordScenario(refundSpec);
    const child = await forkAndReplay({
      trace: r.trace,
      definition: refundSpec.agent,
      parentBranch: r.root,
      parentLineage: r.result.events,
      existingBranches: [r.root],
      forkEventId: findEvent(r.result.events, "tool.request", "refund_order").id,
      overrides: must(refundSpec.fork).overrides,
    });
    // Fork the counterfactual after its pending approval.
    const grandchild = await forkAndReplay({
      trace: r.trace,
      definition: refundSpec.agent,
      parentBranch: child.branch,
      parentLineage: child.lineage,
      existingBranches: [r.root, child.branch],
      forkEventId: findEvent(child.lineage, "model.request", "compose_email").id,
      overrides: [],
    });
    expect(grandchild.replay.status).toBe("completed");
    expect(grandchild.replay.outcome?.kind).toBe("approval_pending");
    expect(asObject(reconstructState(grandchild.lineage).state.approval).status).toBe("pending");
  });
});

describe("ledger overrides", () => {
  const recorded = recordDefinition(ledgerAgentDefinition, LEDGER_INPUT, {
    traceId: "trc_ledger",
    branchId: "br_ledger_main",
  });

  it("state overrides are applied as override patches and change the program's path", async () => {
    const r = await recorded;
    expect(r.result.outcome?.kind).toBe("transferred");
    const child = await forkLedger(r, "fetch_balance", [
      { id: "ovr_limit", kind: "state", op: "set", path: "/limit", value: 50 },
      { id: "ovr_rm", kind: "state", op: "remove", path: "/amount" },
      { id: "ovr_ctx_rm", kind: "context", op: "remove", key: "currency" },
      { id: "ovr_missing", kind: "state", op: "remove", path: "/does-not-exist" },
    ]);
    expect(child.replay.status).toBe("completed");
    expect(child.replay.outcome?.kind).toBe("escalated");
    const overrides = child.replay.events.filter(
      (e) => asObject(e.metadata.shadow).origin === "override",
    );
    expect(overrides.map((e) => [e.eventType, e.name])).toEqual([
      ["state.patch", "/limit"],
      ["state.patch", "/amount"],
      ["context.removed", "currency"],
      ["state.patch", "/does-not-exist"],
    ]);
    expect(must(overrides[0]).output).toEqual({
      ops: [{ op: "replace", path: "/limit", value: 50 }],
    });
    expect(must(overrides[0]).metadata.shadow).toMatchObject({
      overrideKind: "state",
      overrideId: "ovr_limit",
      forkId: child.fork.id,
    });
    expect(must(overrides[1]).output).toEqual({ ops: [{ op: "remove", path: "/amount" }] });
    expect(must(overrides[2]).output).toEqual({ key: "currency" });
    expect(must(overrides[3]).output).toEqual({ ops: [] });
    expect(findEvent(child.replay.events, "tool.request", "escalate").input).toEqual({
      tool: "escalate",
      arguments: { amount: 80, reason: "insufficient" },
    });
    const state = reconstructState(child.lineage);
    expect(state.state.limit).toBe(50);
    expect(state.state.amount).toBeUndefined();
    expect(state.context.currency).toBeUndefined();
  });

  it("tool_error overrides inject failures that the program sees as ToolExecutionError", async () => {
    const r = await recorded;
    const child = await forkLedger(r, "transfer", [
      {
        id: "ovr_err",
        kind: "tool_error",
        tool: "transfer",
        occurrence: 1,
        error: { message: "ledger unavailable", code: "E_LEDGER", retryable: false },
      },
    ]);
    // The replay itself succeeded; the counterfactual program failed.
    expect(child.replay.status).toBe("completed");
    expect(child.replay.branchStatus).toBe("failed");
    expect(child.branch.status).toBe("failed");
    expect(child.replay.outcome).toEqual({ kind: "error", label: "Failed: ledger unavailable" });
    const error = findEvent(child.replay.events, "tool.error", "transfer");
    expect(error.output).toEqual({
      error: { message: "ledger unavailable", code: "E_LEDGER", retryable: false },
    });
    expect(error.metadata.shadow).toMatchObject({
      origin: "replay",
      overrideApplied: true,
      overrideKind: "tool_error",
      overrideId: "ovr_err",
    });
    expect(ofType(child.replay.events, "policy.allowed")).toHaveLength(1); // guard still ran first
    expect(child.replay.events.slice(-3).map((e) => e.eventType)).toEqual([
      "agent.completed",
      "trace.failed",
      "replay.completed",
    ]);
    expect(asObject(must(child.replay.events.at(-1)).output).status).toBe("failed");
  });

  it("policy overrides merge into the policy config and mark the evaluation", async () => {
    const r = await recorded;
    const child = await forkLedger(r, "transfer", [
      { kind: "policy", policy: "ledger.limit", config: { limit: 50 } },
    ]);
    expect(child.replay.outcome?.kind).toBe("escalated");
    const evaluated = findEvent(child.replay.events, "policy.evaluated", "ledger.limit");
    expect(asObject(evaluated.input).config).toEqual({ limit: 50 });
    expect(asObject(evaluated.output).decision).toBe("deny");
    expect(evaluated.metadata.shadow).toMatchObject({ overrideKind: "policy" });
    expect(findEvent(child.replay.events, "tool.error", "transfer").output).toMatchObject({
      error: { code: "policy_blocked" },
    });
    expect(findEvent(child.replay.events, "tool.request", "escalate").input).toEqual({
      tool: "escalate",
      arguments: { amount: 80, reason: "policy" },
    });
  });

  it("honours inherited policy overrides but not inherited state/context overrides", async () => {
    const r = await recorded;
    const child = await forkLedger(r, "transfer", [], {
      inheritedOverrides: [
        { kind: "policy", policy: "ledger.limit", config: { limit: 50 } },
        { kind: "context", op: "set", key: "inherited", value: true },
      ],
    });
    expect(child.replay.outcome?.kind).toBe("escalated");
    expect(
      child.replay.events.filter((e) => asObject(e.metadata.shadow).origin === "override"),
    ).toHaveLength(0);
    expect(reconstructState(child.lineage).context.inherited).toBeUndefined();
  });

  it("a grandchild inherits state overrides through history and passes the fork-point state check", async () => {
    const r = await recorded;
    const child = await forkLedger(r, "fetch_balance", [
      { kind: "state", op: "set", path: "/limit", value: 50 },
    ]);
    expect(child.replay.outcome?.kind).toBe("escalated");
    const grandchild = await forkAndReplay({
      trace: r.trace,
      definition: ledger(),
      parentBranch: child.branch,
      parentLineage: child.lineage,
      existingBranches: [r.root, child.branch],
      forkEventId: findEvent(child.lineage, "tool.request", "escalate").id,
      overrides: [
        { kind: "tool_result", tool: "escalate", occurrence: 1, result: { ticket: "T-override" } },
      ],
    });
    expect(grandchild.replay.status).toBe("completed");
    expect(grandchild.replay.error).toBeNull();
    expect(grandchild.replay.outcome?.kind).toBe("escalated");
    expect(reconstructState(grandchild.lineage).state).toMatchObject({
      limit: 50,
      escalation: { ticket: "T-override" },
    });
  });

  it("replays without overrides reproduce the original outcome", async () => {
    const r = await recorded;
    const child = await forkLedger(r, "fetch_balance", []);
    expect(child.replay.outcome).toEqual(r.result.outcome);
    const original = r.result.events
      .filter((e) => e.sequence > must(child.branch.forkSequence))
      .map((e) => [e.eventType, e.name]);
    const replayed = child.replay.events
      .filter((e) => !e.eventType.startsWith("replay."))
      .map((e) => [e.eventType, e.name]);
    expect(replayed).toEqual(original);
  });
});

describe("history mismatch detection", () => {
  const recorded = recordDefinition(ledgerAgentDefinition, LEDGER_INPUT, {
    traceId: "trc_mismatch",
    branchId: "br_mismatch_main",
  });

  it("fails the replay when the program performs a different operation than recorded", async () => {
    const r = await recorded;
    const child = await forkLedger(r, "fetch_balance", [], {
      definition: ledger(ledgerVariantDefinition),
    });
    expect(child.replay.status).toBe("failed");
    expect(child.replay.branchStatus).toBe("failed");
    expect(child.replay.outcome).toBeNull();
    expect(child.replay.error).toMatch(/could not reproduce the recorded prefix/);
    expect(child.replay.error).toMatch(/expected recorded model.request 'think'/);
    const failed = must(child.replay.events.at(-1));
    expect(failed.eventType).toBe("replay.failed");
    expect(failed.severity).toBe("error");
    expect(asObject(failed.output).details).toMatchObject({
      expectedType: "model.request",
      actualType: "tool.request",
      actualName: "fetch_balance",
    });
    expect(asObject(asObject(failed.output).error).name).toBe("ReplayHistoryMismatchError");
    expect(ofType(child.replay.events, "trace.failed")).toHaveLength(0);
    expect(ofType(child.replay.events, "agent.completed")).toHaveLength(0);
  });

  it("fails the replay when the same operation is performed with different input", async () => {
    const r = await recorded;
    const child = await forkLedger(r, "transfer", [], {
      definition: ledger(ledgerArgumentsVariantDefinition),
    });
    expect(child.replay.status).toBe("failed");
    expect(child.replay.error).toMatch(/could not reproduce/);
    expect(child.replay.error).toMatch(/differs from the recorded input/);
    expect(must(child.replay.events.at(-1)).eventType).toBe("replay.failed");
  });

  it("fails when a recorded request has no recorded response", async () => {
    const r = await recorded;
    const response = findEvent(r.result.events, "tool.response", "fetch_balance");
    const truncated = r.result.events.filter((e) => e.id !== response.id);
    const child = await forkAndReplay({
      trace: r.trace,
      definition: ledger(),
      parentBranch: r.root,
      parentLineage: truncated,
      existingBranches: [r.root],
      forkEventId: findEvent(truncated, "tool.request", "transfer").id,
      overrides: [],
    });
    expect(child.replay.status).toBe("failed");
    expect(child.replay.error).toMatch(/has no response or error/);
  });

  it("fails when the reconstructed state at the fork point disagrees with the program", async () => {
    const r = await recorded;
    // Tamper with the recorded history: the program will set /limit to 200 but the log says 999.
    const tampered = r.result.events.map((e) =>
      e.eventType === "state.patch" && e.name === "/limit"
        ? { ...e, output: { ops: [{ op: "add", path: "/limit", value: 999 }] } }
        : e,
    );
    const child = await forkAndReplay({
      trace: r.trace,
      definition: ledger(),
      parentBranch: r.root,
      parentLineage: tampered,
      existingBranches: [r.root],
      forkEventId: findEvent(tampered, "tool.request", "fetch_balance").id,
      overrides: [],
    });
    expect(child.replay.status).toBe("failed");
    expect(child.replay.error).toMatch(/state at the fork point differs/);
    const failed = must(child.replay.events.at(-1));
    expect(failed.eventType).toBe("replay.failed");
    expect(asObject(asObject(failed.output).details).stateDiff).toEqual([
      { path: "/limit", op: "changed", before: 999, after: 200 },
    ]);
  });
});

describe("createReplay", () => {
  const trace = makeTrace();
  const root = makeBranch({ id: "br_root" });
  const child = makeBranch({
    id: "br_child",
    parentBranchId: "br_root",
    forkId: "frk_1",
    forkEventId: "evt_1",
    forkSequence: 0,
    depth: 1,
    status: "pending",
  });
  const fork = makeFork({ id: "frk_1", childBranchId: "br_child" });

  it("builds a deterministic plan with sensible defaults", () => {
    const plan = createReplay({
      trace,
      branch: child,
      fork,
      parentLineage: [],
      existingBranchEvents: [],
    });
    expect(plan.mode).toBe("deterministic");
    expect(plan.replayId).toMatch(/^rpl_/);
    expect(plan.replayId).toBe(seededIdGenerator("br_child:replay").next("rpl"));
    expect(plan.inheritedOverrides).toEqual([]);
    expect(plan.branch).toBe(child);
    const custom = createReplay({
      trace,
      branch: child,
      fork,
      parentLineage: [],
      existingBranchEvents: [],
      replayId: "rpl_custom",
      mode: "live",
    });
    expect(custom.replayId).toBe("rpl_custom");
    expect(custom.mode).toBe("live");
  });

  it("rejects historical mode", () => {
    expect(() =>
      createReplay({
        trace,
        branch: child,
        fork,
        parentLineage: [],
        existingBranchEvents: [],
        mode: "historical",
      }),
    ).toThrow(ReplayError);
    try {
      createReplay({
        trace,
        branch: child,
        fork,
        parentLineage: [],
        existingBranchEvents: [],
        mode: "historical",
      });
    } catch (error) {
      expect((error as ReplayError).code).toBe("unsupported_mode");
    }
  });

  it("rejects root branches", () => {
    expect(() =>
      createReplay({ trace, branch: root, fork, parentLineage: [], existingBranchEvents: [] }),
    ).toThrow(/only forked branches/);
    try {
      createReplay({ trace, branch: root, fork, parentLineage: [], existingBranchEvents: [] });
    } catch (error) {
      expect((error as ReplayError).code).toBe("invalid_plan");
    }
  });
});

describe("executeReplay options", () => {
  it("accepts a custom clock, id generator and sink and runs in live mode with callbacks", async () => {
    const r = await recordDefinition(ledgerAgentDefinition, LEDGER_INPUT, {
      traceId: "trc_opts",
      branchId: "br_opts",
    });
    const forkEvent = findEvent(r.result.events, "tool.request", "transfer");
    const { createFork } = await import("../src/index.js");
    const forked = createFork({
      trace: r.trace,
      parentBranch: r.root,
      lineage: r.result.events,
      existingBranches: [r.root],
      forkEventId: forkEvent.id,
      overrides: [],
      ids: seededIdGenerator("opts"),
      clock: new VirtualClock(0),
    });
    const plan = createReplay({
      trace: r.trace,
      branch: forked.branch,
      fork: forked.fork,
      parentLineage: r.result.events,
      existingBranchEvents: forked.events,
      mode: "live",
    });
    const seen: string[] = [];
    const clock = new VirtualClock("2040-01-01T00:00:00.000Z");
    const outcome = await executeReplay(plan, ledger(), {
      clock,
      ids: seededIdGenerator("replay-ids"),
      sink: (e) => seen.push(e.id),
    });
    expect(outcome.status).toBe("completed");
    expect(outcome.outcome?.kind).toBe("transferred");
    expect(seen).toEqual(outcome.events.map((e) => e.id));
    expect(must(outcome.events[0]).timestamp).toBe("2040-01-01T00:00:00.000Z");
    expect(must(outcome.events[0]).name).toBe("live");
    expect(must(outcome.events[0]).id).toBe(seededIdGenerator("replay-ids").next("evt"));
  });

  it("continues sequences after any pre-existing child events", async () => {
    const r = await recordDefinition(ledgerAgentDefinition, LEDGER_INPUT, {
      traceId: "trc_seq",
      branchId: "br_seq",
    });
    const forkEvent = findEvent(r.result.events, "tool.request", "transfer");
    const { createFork } = await import("../src/index.js");
    const forked = createFork({
      trace: r.trace,
      parentBranch: r.root,
      lineage: r.result.events,
      existingBranches: [r.root],
      forkEventId: forkEvent.id,
      overrides: [],
      ids: seededIdGenerator("seq"),
      clock: new VirtualClock(0),
    });
    const extra = {
      ...must(forked.events[0]),
      id: "evt_extra",
      sequence: 40,
      eventType: "agent.note",
      name: "manual",
    };
    const plan = createReplay({
      trace: r.trace,
      branch: forked.branch,
      fork: forked.fork,
      parentLineage: r.result.events,
      existingBranchEvents: [...forked.events, extra],
    });
    const outcome = await executeReplay(plan, ledger());
    expect(must(outcome.events[0]).sequence).toBe(41);
  });
});

describe("findAgentInput", () => {
  it("extracts the request from agent.started, falling back gracefully", () => {
    const withRequest = [
      {
        ...makeBranchEvent(),
        eventType: "agent.started",
        input: { agent: "x", request: { q: 1 } },
      },
    ];
    expect(findAgentInput(withRequest)).toEqual({ q: 1 });
    const bareInput = [{ ...makeBranchEvent(), eventType: "agent.started", input: [1, 2] }];
    expect(findAgentInput(bareInput)).toEqual([1, 2]);
    expect(findAgentInput([{ ...makeBranchEvent(), eventType: "agent.started" }])).toBeNull();
    expect(findAgentInput([])).toBeNull();
  });
});

function makeBranchEvent() {
  return {
    id: "evt_x",
    schemaVersion: "1.0",
    traceId: "trc",
    branchId: "br",
    parentEventId: null,
    spanId: null,
    parentSpanId: null,
    sequence: 0,
    timestamp: "2026-01-01T00:00:00.000Z",
    durationMs: null,
    eventType: "agent.note",
    source: "sdk",
    severity: "info" as const,
    name: "n",
    metadata: {},
    tags: [],
    tokenUsage: null,
    estimatedCost: null,
    stateVersion: null,
    correlationId: null,
  };
}
