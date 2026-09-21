import type { BatchCounterfactualBody } from "@shadow/schemas";
import { and, asc, eq } from "drizzle-orm";
import { events } from "../db/schema.js";
import { ApiError } from "../errors.js";
import type { ServiceContext } from "./context.js";
import { forkReplaySummarise, type MatrixVariantResult } from "./matrix.js";
import { listTraces } from "./traces.js";

export type BatchItem =
  | ({
      traceId: string;
      traceName: string;
      startedAt: string;
      status: "ok";
      forkEventId: string;
    } & MatrixVariantResult)
  | {
      traceId: string;
      traceName: string;
      startedAt: string;
      status: "skipped" | "failed";
      reason: string;
    };

export interface BatchResult {
  agent: string;
  at: { eventType: string; name: string };
  /** Traces that matched the filters (before `limit`). */
  matched: number;
  summary: { changed: number; unchanged: number; skipped: number; failed: number };
  results: BatchItem[];
}

/**
 * Apply one override set to many recorded traces of an agent. Each trace is
 * forked on its root branch at the first event matching `at`, replayed
 * deterministically and compared with the original; traces without such an
 * event are skipped and per-trace errors are reported without aborting the batch.
 */
export async function runBatchCounterfactual(
  ctx: ServiceContext,
  body: BatchCounterfactualBody,
): Promise<BatchResult> {
  if (!ctx.registry.has(body.agent)) {
    throw ApiError.unprocessable(
      "agent_not_replayable",
      `no replayable program is registered for agent '${body.agent}'; batch counterfactuals need deterministic replay`,
      { agent: body.agent, replayable: ctx.registry.list().map((d) => d.slug) },
    );
  }
  const page = await listTraces(ctx, {
    agent: body.agent,
    project: body.project,
    status: body.status,
    tag: body.tag,
    from: body.from,
    to: body.to,
    limit: body.limit,
    sort: "startedAt",
    order: "desc",
  });
  const results: BatchItem[] = [];
  for (const trace of page.items) {
    const base = { traceId: trace.id, traceName: trace.name, startedAt: trace.startedAt };
    const [event] = await ctx.handle.db
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.traceId, trace.id),
          eq(events.branchId, trace.rootBranchId),
          eq(events.eventType, body.at.eventType),
          eq(events.name, body.at.name),
        ),
      )
      .orderBy(asc(events.sequence))
      .limit(1);
    if (!event) {
      results.push({
        ...base,
        status: "skipped",
        reason: `no ${body.at.eventType} '${body.at.name}' event on the root branch`,
      });
      continue;
    }
    try {
      const { parentBranchId: _parent, ...summary } = await forkReplaySummarise(ctx, trace.id, {
        forkEventId: event.id,
        parentBranchId: trace.rootBranchId,
        name: body.branchName,
        overrides: body.overrides,
      });
      results.push({ ...base, status: "ok", forkEventId: event.id, ...summary });
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      results.push({ ...base, status: "failed", reason: `${error.code}: ${error.message}` });
    }
  }
  const ok = results.filter((r): r is Extract<BatchItem, { status: "ok" }> => r.status === "ok");
  return {
    agent: body.agent,
    at: body.at,
    matched: page.total,
    summary: {
      changed: ok.filter((r) => r.outcome.changed).length,
      unchanged: ok.filter((r) => !r.outcome.changed).length,
      skipped: results.filter((r) => r.status === "skipped").length,
      failed: results.filter((r) => r.status === "failed").length,
    },
    results,
  };
}
