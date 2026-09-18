import { compareBranches } from "@shadow/core";
import type { Comparison, Fork } from "@shadow/schemas";
import { and, desc, eq, lt, or, type SQL } from "drizzle-orm";
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

interface ComparisonCursor {
  createdAt: string;
  id: string;
}

function encodeComparisonCursor(cursor: ComparisonCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeComparisonCursor(raw: string | undefined): ComparisonCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) as Partial<ComparisonCursor>;
    if (typeof parsed.createdAt === "string" && typeof parsed.id === "string") {
      return { createdAt: parsed.createdAt, id: parsed.id };
    }
  } catch {
    // fall through
  }
  throw ApiError.badRequest("invalid cursor");
}

/** Newest first, keyset-paginated on (createdAt, id). */
export async function listComparisons(
  ctx: ServiceContext,
  query: { traceId?: string; branchId?: string; limit: number; cursor?: string },
): Promise<{ items: Comparison[]; nextCursor: string | null }> {
  const filters: SQL[] = [];
  const after = decodeComparisonCursor(query.cursor);
  if (after) {
    filters.push(
      or(
        lt(comparisons.createdAt, after.createdAt),
        and(eq(comparisons.createdAt, after.createdAt), lt(comparisons.id, after.id)),
      ) as SQL,
    );
  }
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
    .orderBy(desc(comparisons.createdAt), desc(comparisons.id))
    .limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return {
    items: page.map(toComparison),
    nextCursor:
      rows.length > query.limit && last
        ? encodeComparisonCursor({ createdAt: iso(last.createdAt), id: last.id })
        : null,
  };
}
