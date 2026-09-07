import { describe, expect, it } from "vitest";
import { buildEventTree, flattenTree, isSpanOpener, type EventTreeNode } from "../src/index.js";
import { demoTraces, findEvent, makeEvent, must, recordScenario } from "./helpers.js";

function findNode(nodes: readonly EventTreeNode[], id: string): EventTreeNode | undefined {
  for (const node of nodes) {
    if (node.event.id === id) return node;
    const inner = findNode(node.children, id);
    if (inner) return inner;
  }
  return undefined;
}

describe("isSpanOpener", () => {
  it("recognises tool, model and agent openers only", () => {
    expect(isSpanOpener({ eventType: "tool.request" })).toBe(true);
    expect(isSpanOpener({ eventType: "model.request" })).toBe(true);
    expect(isSpanOpener({ eventType: "agent.started" })).toBe(true);
    expect(isSpanOpener({ eventType: "tool.response" })).toBe(false);
    expect(isSpanOpener({ eventType: "state.patch" })).toBe(false);
  });
});

describe("buildEventTree on a recorded refund trace", () => {
  const recorded = recordScenario(must(demoTraces[0]));

  it("nests responses under their requests and operations under the agent span", async () => {
    const { result } = await recorded;
    const tree = buildEventTree(result.events);
    // Roots: trace.started, agent.started, trace.failed.
    expect(tree.map((n) => n.event.eventType)).toEqual([
      "trace.started",
      "agent.started",
      "trace.failed",
    ]);

    const agent = must(tree[1]);
    expect(agent.depth).toBe(0);
    expect(agent.children.length).toBeGreaterThan(10);
    for (const child of agent.children) expect(child.depth).toBe(1);

    const request = findEvent(result.events, "tool.request", "read_customer");
    const response = findEvent(result.events, "tool.response", "read_customer");
    const requestNode = must(findNode(tree, request.id));
    expect(requestNode.depth).toBe(1);
    expect(requestNode.children.map((n) => n.event.id)).toEqual([response.id]);
    expect(must(requestNode.children[0]).depth).toBe(2);
    expect(requestNode.spanDurationMs).toBe(response.durationMs);

    const modelRequest = findEvent(result.events, "model.request", "plan");
    const modelNode = must(findNode(tree, modelRequest.id));
    expect(modelNode.children.map((n) => n.event.eventType)).toEqual(["model.response"]);
    expect(modelNode.spanDurationMs).toBe(720);
  });

  it("nests the guard policy evaluation (and its outcome) under the guarded tool request", async () => {
    const { result } = await recorded;
    const tree = buildEventTree(result.events);
    const refund = findEvent(result.events, "tool.request", "refund_order");
    const node = must(findNode(tree, refund.id));
    expect(node.children.map((n) => n.event.eventType)).toEqual([
      "policy.evaluated",
      "tool.response",
    ]);
    const evaluated = must(node.children[0]);
    expect(evaluated.depth).toBe(2);
    expect(evaluated.children.map((n) => n.event.eventType)).toEqual(["policy.allowed"]);
    expect(must(evaluated.children[0]).depth).toBe(3);
    expect(node.spanDurationMs).toBe(900);
  });

  it("sets the agent span duration from agent.completed and flattens in pre-order", async () => {
    const { result } = await recorded;
    const tree = buildEventTree(result.events);
    const agent = must(tree[1]);
    const completed = findEvent(result.events, "agent.completed");
    expect(agent.spanDurationMs).toBe(completed.durationMs);
    expect(must(tree[0]).spanDurationMs).toBeNull();

    const flat = flattenTree(tree);
    expect(flat).toHaveLength(result.events.length);
    // Pre-order traversal of a hierarchy built from a sequential log keeps sequence order.
    expect(flat.map((n) => n.event.sequence)).toEqual(result.events.map((e) => e.sequence));
    const ids = new Set(flat.map((n) => n.event.id));
    expect(ids.size).toBe(result.events.length);
  });
});

describe("buildEventTree on hand-built events", () => {
  it("falls back to span ownership when no parentEventId is set", () => {
    const events = [
      makeEvent({ sequence: 0, eventType: "agent.started", name: "agent", spanId: "spn_agent" }),
      makeEvent({
        sequence: 1,
        eventType: "tool.request",
        name: "t",
        spanId: "spn_tool",
        parentSpanId: "spn_agent",
      }),
      makeEvent({ sequence: 2, eventType: "agent.note", name: "inside", spanId: "spn_tool" }),
      makeEvent({
        sequence: 3,
        eventType: "tool.response",
        name: "t",
        spanId: "spn_tool",
        parentSpanId: "spn_agent",
        parentEventId: "evt_1",
        durationMs: 40,
      }),
      makeEvent({ sequence: 4, eventType: "agent.note", name: "loose", spanId: "spn_unknown" }),
    ];
    const tree = buildEventTree(events);
    expect(tree.map((n) => n.event.id)).toEqual(["evt_0", "evt_4"]);
    const agent = must(tree[0]);
    expect(agent.children.map((n) => n.event.id)).toEqual(["evt_1"]);
    const tool = must(agent.children[0]);
    expect(tool.children.map((n) => n.event.id)).toEqual(["evt_2", "evt_3"]);
    expect(tool.spanDurationMs).toBe(40);
    expect(must(tool.children[0]).depth).toBe(2);
  });

  it("keeps a node as a root when its parent is missing from the list", () => {
    const events = [
      makeEvent({
        sequence: 5,
        eventType: "tool.response",
        name: "t",
        parentEventId: "evt_missing",
      }),
    ];
    const tree = buildEventTree(events);
    expect(tree).toHaveLength(1);
    expect(must(tree[0]).depth).toBe(0);
  });

  it("does not credit a span duration from a child in a different span", () => {
    const events = [
      makeEvent({ sequence: 0, eventType: "tool.request", name: "outer", spanId: "spn_outer" }),
      makeEvent({
        sequence: 1,
        eventType: "agent.note",
        name: "n",
        parentEventId: "evt_0",
        spanId: "spn_other",
        durationMs: 99,
      }),
    ];
    const tree = buildEventTree(events);
    expect(must(tree[0]).spanDurationMs).toBeNull();
    expect(flattenTree(tree)).toHaveLength(2);
  });
});
