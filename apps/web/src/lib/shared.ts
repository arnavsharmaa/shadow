import type { Branch, ShadowEvent, TraceExport } from "@shadow/schemas";

/**
 * The events a branch shows in a bundle: its ancestors' events up to each fork point, then its
 * own. Bundles store every event once, on the branch that recorded it, the same lineage rule the
 * API applies for `inherited=true`.
 */
export function branchEvents(
  bundle: Pick<TraceExport, "branches" | "events">,
  branchId: string,
): ShadowEvent[] {
  const byId = new Map(bundle.branches.map((b) => [b.id, b]));
  const chain: { branch: Branch; upTo: number }[] = [];
  let upTo = Number.POSITIVE_INFINITY;
  const seen = new Set<string>();
  for (let branch = byId.get(branchId); branch && !seen.has(branch.id);) {
    seen.add(branch.id);
    chain.push({ branch, upTo });
    upTo = Math.min(upTo, branch.forkSequence ?? Number.POSITIVE_INFINITY);
    branch = branch.parentBranchId ? byId.get(branch.parentBranchId) : undefined;
  }
  const limits = new Map(chain.map((c) => [c.branch.id, c.upTo]));
  return bundle.events
    .filter((e) => {
      const limit = limits.get(e.branchId);
      return limit !== undefined && e.sequence <= limit;
    })
    .sort((a, b) => a.sequence - b.sequence);
}
