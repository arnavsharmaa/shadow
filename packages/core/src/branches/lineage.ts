import type { Branch, ShadowEvent } from "@shadow/schemas";
import { sortEvents } from "../events/ordering.js";

export class LineageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LineageError";
  }
}

export interface BranchTreeNode {
  branch: Branch;
  children: BranchTreeNode[];
}

/** Root-to-leaf chain of branches ending at `branchId`. */
export function resolveLineage(branches: readonly Branch[], branchId: string): Branch[] {
  const byId = new Map(branches.map((b) => [b.id, b]));
  const chain: Branch[] = [];
  let current = byId.get(branchId);
  if (!current) throw new LineageError(`unknown branch ${branchId}`);
  const seen = new Set<string>();
  while (current) {
    if (seen.has(current.id)) throw new LineageError(`cycle detected at branch ${current.id}`);
    seen.add(current.id);
    chain.unshift(current);
    current = current.parentBranchId ? byId.get(current.parentBranchId) : undefined;
    if (chain[0]?.parentBranchId && !current) {
      throw new LineageError(`missing parent ${chain[0].parentBranchId} for branch ${chain[0].id}`);
    }
  }
  return chain;
}

/**
 * Merge inherited and own events into a branch's effective timeline.
 * `ownEvents` maps branchId → events stored on that branch.
 */
export function effectiveEvents(
  branches: readonly Branch[],
  branchId: string,
  ownEvents: (branchId: string) => readonly ShadowEvent[],
): ShadowEvent[] {
  const chain = resolveLineage(branches, branchId);
  let timeline: ShadowEvent[] = [];
  for (let i = 0; i < chain.length; i++) {
    const branch = chain[i] as Branch;
    const child = chain[i + 1];
    const own = sortEvents(ownEvents(branch.id));
    timeline = timeline.concat(own);
    if (child && child.forkSequence != null) {
      const cutoff = child.forkSequence;
      timeline = timeline.filter((e) => e.sequence <= cutoff);
    }
  }
  return sortEvents(timeline);
}

/** Sequence of the last event shared by two lineages (-1 when none). */
export function sharedPrefixSequence(a: readonly ShadowEvent[], b: readonly ShadowEvent[]): number {
  let shared = -1;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] as ShadowEvent;
    const y = b[i] as ShadowEvent;
    if (x.id !== y.id) break;
    shared = x.sequence;
  }
  return shared;
}

export function buildBranchTree(branches: readonly Branch[]): BranchTreeNode[] {
  const nodes = new Map<string, BranchTreeNode>();
  for (const branch of branches) nodes.set(branch.id, { branch, children: [] });
  const roots: BranchTreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.branch.parentBranchId ? nodes.get(node.branch.parentBranchId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sortNodes = (list: BranchTreeNode[]) => {
    list.sort(
      (x, y) =>
        x.branch.createdAt.localeCompare(y.branch.createdAt) ||
        x.branch.id.localeCompare(y.branch.id),
    );
    list.forEach((n) => sortNodes(n.children));
  };
  sortNodes(roots);
  return roots;
}

/** Default name for the n-th fork in a trace: fork-1, fork-2, … */
export function defaultBranchName(existing: readonly Branch[]): string {
  let n = 1;
  const names = new Set(existing.map((b) => b.name));
  while (names.has(`fork-${n}`)) n++;
  return `fork-${n}`;
}
