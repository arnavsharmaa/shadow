import type { Branch, ShadowEvent } from "@shadow/schemas";
import { describe, expect, it } from "vitest";
import {
  LineageError,
  buildBranchTree,
  defaultBranchName,
  effectiveEvents,
  resolveLineage,
  sharedPrefixSequence,
} from "../src/index.js";
import { makeBranch, makeEvent, must } from "./helpers.js";

const root = makeBranch({ id: "br_root", createdAt: "2026-01-01T00:00:00.000Z" });
const child = makeBranch({
  id: "br_child",
  parentBranchId: "br_root",
  forkSequence: 2,
  depth: 1,
  createdAt: "2026-01-01T00:01:00.000Z",
});
const grandchild = makeBranch({
  id: "br_grandchild",
  parentBranchId: "br_child",
  forkSequence: 4,
  depth: 2,
  createdAt: "2026-01-01T00:02:00.000Z",
});
const sibling = makeBranch({
  id: "br_sibling",
  parentBranchId: "br_root",
  forkSequence: 1,
  depth: 1,
  createdAt: "2026-01-01T00:00:30.000Z",
});
const branches: Branch[] = [grandchild, sibling, child, root];

/** Own events: root 0..5, child 3..6 (after fork at 2), grandchild 5..7 (after fork at 4). */
function ownEvents(branchId: string): ShadowEvent[] {
  const range = (from: number, to: number, prefix: string) =>
    Array.from({ length: to - from + 1 }, (_, i) =>
      makeEvent({ sequence: from + i, id: `${prefix}_${from + i}`, branchId }),
    );
  switch (branchId) {
    case "br_root":
      return range(0, 5, "root").reverse(); // deliberately unsorted
    case "br_child":
      return range(3, 6, "child");
    case "br_grandchild":
      return range(5, 7, "gc");
    case "br_sibling":
      return range(2, 3, "sib");
    default:
      return [];
  }
}

describe("resolveLineage", () => {
  it("returns the root-to-leaf chain", () => {
    expect(resolveLineage(branches, "br_root").map((b) => b.id)).toEqual(["br_root"]);
    expect(resolveLineage(branches, "br_child").map((b) => b.id)).toEqual(["br_root", "br_child"]);
    expect(resolveLineage(branches, "br_grandchild").map((b) => b.id)).toEqual([
      "br_root",
      "br_child",
      "br_grandchild",
    ]);
  });

  it("throws for unknown branches, missing parents and cycles", () => {
    expect(() => resolveLineage(branches, "br_nope")).toThrow(LineageError);
    expect(() => resolveLineage(branches, "br_nope")).toThrow(/unknown branch/);
    const orphan = makeBranch({ id: "br_orphan", parentBranchId: "br_missing" });
    expect(() => resolveLineage([orphan], "br_orphan")).toThrow(
      /missing parent br_missing for branch br_orphan/,
    );
    const a = makeBranch({ id: "br_a", parentBranchId: "br_b" });
    const b = makeBranch({ id: "br_b", parentBranchId: "br_a" });
    expect(() => resolveLineage([a, b], "br_a")).toThrow(/cycle detected/);
  });
});

describe("effectiveEvents", () => {
  it("returns the root's own events sorted", () => {
    const events = effectiveEvents(branches, "br_root", ownEvents);
    expect(events.map((e) => e.id)).toEqual([
      "root_0",
      "root_1",
      "root_2",
      "root_3",
      "root_4",
      "root_5",
    ]);
  });

  it("merges the inherited prefix (up to the fork sequence) with the child's own events", () => {
    const events = effectiveEvents(branches, "br_child", ownEvents);
    expect(events.map((e) => e.id)).toEqual([
      "root_0",
      "root_1",
      "root_2",
      "child_3",
      "child_4",
      "child_5",
      "child_6",
    ]);
    expect(events.map((e) => e.sequence)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("applies each fork cutoff in turn for deeper lineages", () => {
    const events = effectiveEvents(branches, "br_grandchild", ownEvents);
    expect(events.map((e) => e.id)).toEqual([
      "root_0",
      "root_1",
      "root_2",
      "child_3",
      "child_4",
      "gc_5",
      "gc_6",
      "gc_7",
    ]);
  });

  it("handles siblings independently", () => {
    const events = effectiveEvents(branches, "br_sibling", ownEvents);
    expect(events.map((e) => e.id)).toEqual(["root_0", "root_1", "sib_2", "sib_3"]);
  });

  it("keeps everything from a parent when the child has no fork sequence", () => {
    const loose = makeBranch({ id: "br_loose", parentBranchId: "br_root" });
    const events = effectiveEvents([...branches, loose], "br_loose", (id) =>
      id === "br_loose" ? [makeEvent({ sequence: 9, id: "loose_9" })] : ownEvents(id),
    );
    expect(events.map((e) => e.id)).toEqual([
      "root_0",
      "root_1",
      "root_2",
      "root_3",
      "root_4",
      "root_5",
      "loose_9",
    ]);
  });
});

describe("sharedPrefixSequence", () => {
  it("returns the sequence of the last event both lineages share", () => {
    const base = effectiveEvents(branches, "br_root", ownEvents);
    const target = effectiveEvents(branches, "br_child", ownEvents);
    expect(sharedPrefixSequence(base, target)).toBe(2);
    expect(sharedPrefixSequence(base, effectiveEvents(branches, "br_grandchild", ownEvents))).toBe(
      2,
    );
    expect(
      sharedPrefixSequence(target, effectiveEvents(branches, "br_grandchild", ownEvents)),
    ).toBe(4);
  });

  it("returns -1 for unrelated lineages and the full length for identical ones", () => {
    const base = effectiveEvents(branches, "br_root", ownEvents);
    expect(sharedPrefixSequence(base, [])).toBe(-1);
    expect(sharedPrefixSequence(base, [makeEvent({ sequence: 0, id: "other" })])).toBe(-1);
    expect(sharedPrefixSequence(base, base)).toBe(5);
  });
});

describe("buildBranchTree", () => {
  it("nests children under parents and orders siblings by creation time then id", () => {
    const tree = buildBranchTree(branches);
    expect(tree).toHaveLength(1);
    const rootNode = must(tree[0]);
    expect(rootNode.branch.id).toBe("br_root");
    expect(rootNode.children.map((n) => n.branch.id)).toEqual(["br_sibling", "br_child"]);
    const childNode = must(rootNode.children[1]);
    expect(childNode.children.map((n) => n.branch.id)).toEqual(["br_grandchild"]);
  });

  it("treats branches with unknown parents as roots and breaks ties by id", () => {
    const same = "2026-01-01T00:00:00.000Z";
    const tree = buildBranchTree([
      makeBranch({ id: "br_b", createdAt: same }),
      makeBranch({ id: "br_a", createdAt: same }),
      makeBranch({ id: "br_orphan", parentBranchId: "br_missing", createdAt: same }),
    ]);
    expect(tree.map((n) => n.branch.id)).toEqual(["br_a", "br_b", "br_orphan"]);
  });
});

describe("defaultBranchName", () => {
  it("picks the first unused fork-N name", () => {
    expect(defaultBranchName([])).toBe("fork-1");
    expect(defaultBranchName([makeBranch({ id: "x", name: "fork-1" })])).toBe("fork-2");
    expect(
      defaultBranchName([
        makeBranch({ id: "x", name: "fork-1" }),
        makeBranch({ id: "y", name: "fork-3" }),
      ]),
    ).toBe("fork-2");
    expect(defaultBranchName([makeBranch({ id: "x", name: "main" })])).toBe("fork-1");
  });
});
