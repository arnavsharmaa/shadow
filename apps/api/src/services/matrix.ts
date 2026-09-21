import type { Branch, FirstDivergence, ForkMatrixBody, Outcome, Replay } from "@shadow/schemas";
import { ApiError } from "../errors.js";
import { createForkForTrace, runReplay } from "./branches.js";
import { createComparison } from "./comparisons.js";
import type { ServiceContext } from "./context.js";
import { getTraceSummary } from "./traces.js";

export interface MatrixVariantResult {
  name: string;
  branch: Branch;
  replay: Replay;
  comparisonId: string;
  outcome: { base: Outcome | null; target: Outcome | null; changed: boolean };
  policyChanged: boolean;
  firstDivergence: Pick<FirstDivergence, "sequence" | "reason" | "summary"> | null;
  deltas: {
    totalEstimatedCost: number;
    durationMs: number;
    totalTokens: number;
    toolCalls: number;
  };
}

/** Fork an event, replay the fork deterministically and summarise its comparison with the parent. */
export async function forkReplaySummarise(
  ctx: ServiceContext,
  traceId: string,
  input: {
    forkEventId: string;
    parentBranchId?: string;
    name?: string;
    overrides: ForkMatrixBody["variants"][number]["overrides"];
  },
): Promise<MatrixVariantResult & { parentBranchId: string }> {
  const { branch, fork } = await createForkForTrace(ctx, traceId, {
    forkEventId: input.forkEventId,
    parentBranchId: input.parentBranchId,
    name: input.name,
    overrides: input.overrides,
  });
  const replayed = await runReplay(ctx, branch.id, "deterministic");
  const comparison = await createComparison(ctx, {
    baseBranchId: fork.parentBranchId,
    targetBranchId: branch.id,
  });
  const r = comparison.result;
  return {
    parentBranchId: fork.parentBranchId,
    name: replayed.branch.name,
    branch: replayed.branch,
    replay: replayed.replay,
    comparisonId: comparison.id,
    outcome: r.outcome,
    policyChanged: r.policy.changed,
    firstDivergence: r.firstDivergence
      ? {
          sequence: r.firstDivergence.sequence,
          reason: r.firstDivergence.reason,
          summary: r.firstDivergence.summary,
        }
      : null,
    deltas: {
      totalEstimatedCost: r.metrics.totalEstimatedCost.delta,
      durationMs: r.metrics.durationMs.delta,
      totalTokens: r.metrics.totalTokens.delta,
      toolCalls: r.metrics.toolCalls.delta,
    },
  };
}

export interface MatrixResult {
  traceId: string;
  forkEventId: string;
  parentBranchId: string;
  variants: MatrixVariantResult[];
}

/**
 * Scenario matrix: fork the same event once per variant, replay each fork
 * deterministically and compare it with the parent branch, so a grid of
 * what-ifs ("refundLimit = 50 / 100 / 500") is answered in one request.
 * Variants run sequentially; every fork, replay and comparison is stored like
 * a manually created one.
 */
export async function runForkMatrix(
  ctx: ServiceContext,
  traceId: string,
  body: ForkMatrixBody,
): Promise<MatrixResult> {
  const trace = await getTraceSummary(ctx, traceId);
  // Fail before creating any fork when replay is impossible, to avoid stray branches.
  if (!ctx.registry.has(trace.agentSlug)) {
    throw ApiError.unprocessable(
      "agent_not_replayable",
      `no replayable program is registered for agent '${trace.agentSlug}'; a scenario matrix needs deterministic replay`,
      { agent: trace.agentSlug, replayable: ctx.registry.list().map((d) => d.slug) },
    );
  }
  const names = body.variants.map((v) => v.name).filter((n): n is string => n !== undefined);
  if (new Set(names).size !== names.length) {
    throw ApiError.badRequest("variant names must be unique");
  }

  const variants: MatrixVariantResult[] = [];
  let parentBranchId = body.parentBranchId;
  for (const variant of body.variants) {
    const { parentBranchId: resolvedParent, ...summary } = await forkReplaySummarise(ctx, traceId, {
      forkEventId: body.forkEventId,
      parentBranchId,
      name: variant.name,
      overrides: variant.overrides,
    });
    parentBranchId = resolvedParent;
    variants.push(summary);
  }
  return {
    traceId,
    forkEventId: body.forkEventId,
    parentBranchId: parentBranchId as string,
    variants,
  };
}
