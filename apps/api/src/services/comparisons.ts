import { compareBranches } from "@shadow/core";
import type { Comparison, Fork } from "@shadow/schemas";
import { and, desc, eq, or, type SQL } from "drizzle-orm";
import { comparisons, forks } from "../db/schema.js";
import { ApiError } from "../errors.js";
import type { ServiceContext } from "./context.js";
import { getBranchRow, loadEffectiveEvents } from "./events.js";
import { iso, toBranch, toComparison, toFork } from "./mappers.js";

export async function createComparison(
  ctx: ServiceContext,
  input: { baseBranchId: string; targetBranchId: string },
): Promise<Comparison> {
  const base = toBranch(await getBranchRow(ctx, input.baseBranchId));
  const target = toBranch(await getBranchRow(ctx, input.targetBranchId));
  if (base.id === target.id)
    throw ApiError.unprocessable("same_branch", "choose two different branches");
  // Branches of different traces share no prefix, so every step is aligned by content:
  // this is how two separately recorded runs of an agent are compared.
  const crossTrace = base.traceId !== target.traceId;
  const [baseEvents, targetEvents] = await Promise.all([
    loadEffectiveEvents(ctx, base.id),
    loadEffectiveEvents(ctx, target.id),
  ]);
  let overrides: Fork["overrides"] = [];
  const forkId = target.forkId ?? base.forkId;
  if (forkId) {
    const [forkRow] = await ctx.handle.db.select().from(forks).where(eq(forks.id, forkId)).limit(1);
    if (forkRow) overrides = toFork(forkRow).overrides;
  }
  const result = compareBranches(
    { branch: base, events: baseEvents },
    { branch: target, events: targetEvents },
    { overrides },
  );
  const row = {
    id: ctx.ids.next("cmp"),
    traceId: base.traceId,
    targetTraceId: crossTrace ? target.traceId : null,
    baseBranchId: base.id,
    targetBranchId: target.id,
    result,
    createdAt: iso(new Date(ctx.clock.now())),
  };
  await ctx.handle.db.insert(comparisons).values(row);
  ctx.metrics.comparisons.inc({ kind: crossTrace ? "cross_trace" : "branch" });
  return toComparison({ ...row, result });
}

export async function getComparison(
  ctx: ServiceContext,
  comparisonId: string,
): Promise<Comparison> {
  const [row] = await ctx.handle.db
    .select()
    .from(comparisons)
    .where(eq(comparisons.id, comparisonId))
    .limit(1);
  if (!row) throw ApiError.notFound("comparison", comparisonId);
  return toComparison(row);
}

export async function listComparisons(
  ctx: ServiceContext,
  query: { traceId?: string; branchId?: string; limit: number },
): Promise<{ items: Comparison[]; nextCursor: null }> {
  const filters: SQL[] = [];
  if (query.traceId) {
    filters.push(
      or(
        eq(comparisons.traceId, query.traceId),
        eq(comparisons.targetTraceId, query.traceId),
      ) as SQL,
    );
  }
  if (query.branchId) {
    filters.push(
      or(
        eq(comparisons.baseBranchId, query.branchId),
        eq(comparisons.targetBranchId, query.branchId),
      ) as SQL,
    );
  }
  const base = ctx.handle.db.select().from(comparisons);
  const rows = await (filters.length > 0 ? base.where(and(...filters)) : base)
    .orderBy(desc(comparisons.createdAt))
    .limit(query.limit);
  return { items: rows.map(toComparison), nextCursor: null };
}
