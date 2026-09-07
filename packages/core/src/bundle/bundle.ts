import type { Branch, IdPrefix, ShadowEvent, TraceExport } from "@shadow/schemas";
import { isCompatibleSchemaVersion, traceExportSchema } from "@shadow/schemas";
import { assertStrictlyIncreasing, sortEvents } from "../events/ordering.js";
import { randomIdGenerator, type IdGenerator } from "../ids.js";

export class BundleValidationError extends Error {
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(message);
    this.name = "BundleValidationError";
  }
}

/** Parse and structurally validate an export bundle. */
export function parseBundle(raw: unknown): TraceExport {
  const parsed = traceExportSchema.safeParse(raw);
  if (!parsed.success) {
    throw new BundleValidationError(
      "bundle does not match the shadow.trace format",
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    );
  }
  const bundle = parsed.data;
  const issues: string[] = [];
  if (!isCompatibleSchemaVersion(bundle.schemaVersion)) {
    issues.push(`unsupported schemaVersion ${bundle.schemaVersion}`);
  }
  const branchIds = new Set(bundle.branches.map((b) => b.id));
  if (!branchIds.has(bundle.trace.rootBranchId)) {
    issues.push(`root branch ${bundle.trace.rootBranchId} missing`);
  }
  for (const branch of bundle.branches) {
    if (branch.traceId !== bundle.trace.id)
      issues.push(`branch ${branch.id} belongs to another trace`);
    if (branch.parentBranchId && !branchIds.has(branch.parentBranchId)) {
      issues.push(`branch ${branch.id} references missing parent ${branch.parentBranchId}`);
    }
  }
  const eventIds = new Set<string>();
  const byBranch = new Map<string, ShadowEvent[]>();
  for (const event of bundle.events) {
    if (event.traceId !== bundle.trace.id)
      issues.push(`event ${event.id} belongs to another trace`);
    if (!branchIds.has(event.branchId)) {
      issues.push(`event ${event.id} references missing branch ${event.branchId}`);
    }
    if (eventIds.has(event.id)) issues.push(`duplicate event id ${event.id}`);
    eventIds.add(event.id);
    byBranch.set(event.branchId, [...(byBranch.get(event.branchId) ?? []), event]);
  }
  for (const [branchId, events] of byBranch) {
    try {
      assertStrictlyIncreasing(sortEvents(events));
    } catch (error) {
      issues.push(`branch ${branchId}: ${(error as Error).message}`);
    }
  }
  for (const fork of bundle.forks) {
    if (!branchIds.has(fork.childBranchId) || !branchIds.has(fork.parentBranchId)) {
      issues.push(`fork ${fork.id} references unknown branches`);
    }
  }
  if (issues.length > 0) throw new BundleValidationError("bundle failed validation", issues);
  return bundle;
}

/** Assign fresh ids to every entity in a bundle, preserving all references. */
export function regenerateBundleIds(
  bundle: TraceExport,
  ids: IdGenerator = randomIdGenerator(),
): TraceExport {
  const map = new Map<string, string>();
  const remap = (id: string, prefix: IdPrefix) => {
    const existing = map.get(id);
    if (existing) return existing;
    const next = ids.next(prefix);
    map.set(id, next);
    return next;
  };
  const opt = (id: string | null | undefined, prefix: IdPrefix): string | null =>
    id == null ? null : remap(id, prefix);

  const traceId = remap(bundle.trace.id, "trc");
  for (const b of bundle.branches) remap(b.id, "br");
  for (const f of bundle.forks) remap(f.id, "frk");
  for (const e of bundle.events) remap(e.id, "evt");
  const spanIds = new Set<string>();
  for (const e of bundle.events) {
    if (e.spanId) spanIds.add(e.spanId);
    if (e.parentSpanId) spanIds.add(e.parentSpanId);
  }
  for (const s of spanIds) remap(s, "spn");

  const branches: Branch[] = bundle.branches.map((b) => ({
    ...b,
    id: remap(b.id, "br"),
    traceId,
    parentBranchId: opt(b.parentBranchId, "br"),
    forkId: opt(b.forkId, "frk"),
    forkEventId: opt(b.forkEventId, "evt"),
  }));
  return {
    ...bundle,
    trace: { ...bundle.trace, id: traceId, rootBranchId: remap(bundle.trace.rootBranchId, "br") },
    branches,
    forks: bundle.forks.map((f) => ({
      ...f,
      id: remap(f.id, "frk"),
      traceId,
      parentBranchId: remap(f.parentBranchId, "br"),
      childBranchId: remap(f.childBranchId, "br"),
      forkEventId: remap(f.forkEventId, "evt"),
    })),
    replays: bundle.replays.map((r) => ({
      ...r,
      id: ids.next("rpl"),
      traceId,
      branchId: remap(r.branchId, "br"),
      forkId: opt(r.forkId, "frk"),
    })),
    events: bundle.events.map((e) => ({
      ...e,
      id: remap(e.id, "evt"),
      traceId,
      branchId: remap(e.branchId, "br"),
      parentEventId: opt(e.parentEventId, "evt"),
      spanId: opt(e.spanId, "spn"),
      parentSpanId: opt(e.parentSpanId, "spn"),
      metadata: remapMetadata(e.metadata, map),
    })),
    comparisons: bundle.comparisons.map((c) => ({
      ...c,
      id: ids.next("cmp"),
      traceId,
      baseBranchId: remap(c.baseBranchId, "br"),
      targetBranchId: remap(c.targetBranchId, "br"),
    })),
  };
}

function remapMetadata(
  metadata: ShadowEvent["metadata"],
  map: Map<string, string>,
): ShadowEvent["metadata"] {
  const shadow = metadata.shadow;
  if (!shadow || typeof shadow !== "object" || Array.isArray(shadow)) return metadata;
  const next = { ...shadow };
  for (const key of ["forkId", "correspondsTo", "replayId"] as const) {
    const value = next[key];
    if (typeof value === "string" && map.has(value)) next[key] = map.get(value) as string;
  }
  return { ...metadata, shadow: next };
}
