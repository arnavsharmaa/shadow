import { toJson } from "@shadow/core";
import type {
  BatchCounterfactualBody,
  BatchJob,
  BatchJobStatus,
  JsonObject,
} from "@shadow/schemas";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { batchJobs, events } from "../db/schema.js";
import { ApiError } from "../errors.js";
import type { JobControl } from "../jobs/runner.js";
import type { ServiceContext } from "./context.js";
import { iso } from "./mappers.js";
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

export interface BatchProgress {
  total: number;
  done: number;
  changed: number;
  unchanged: number;
  skipped: number;
  failed: number;
}

interface BatchHooks {
  onProgress?: (progress: BatchProgress) => Promise<void>;
  control?: JobControl;
}

function assertReplayable(ctx: ServiceContext, agent: string): void {
  if (!ctx.registry.has(agent)) {
    throw ApiError.unprocessable(
      "agent_not_replayable",
      `no replayable program is registered for agent '${agent}'; batch counterfactuals need deterministic replay`,
      { agent, replayable: ctx.registry.list().map((d) => d.slug) },
    );
  }
}

function summarise(results: BatchItem[]): BatchResult["summary"] {
  const ok = results.filter((r): r is Extract<BatchItem, { status: "ok" }> => r.status === "ok");
  return {
    changed: ok.filter((r) => r.outcome.changed).length,
    unchanged: ok.filter((r) => !r.outcome.changed).length,
    skipped: results.filter((r) => r.status === "skipped").length,
    failed: results.filter((r) => r.status === "failed").length,
  };
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
  hooks: BatchHooks = {},
): Promise<BatchResult> {
  assertReplayable(ctx, body.agent);
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
  const report = async () => {
    await hooks.onProgress?.({
      total: page.items.length,
      done: results.length,
      ...summarise(results),
    });
  };
  await report();
  for (const trace of page.items) {
    if (hooks.control?.cancelled()) break;
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
      await report();
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
    await report();
  }
  return {
    agent: body.agent,
    at: body.at,
    matched: page.total,
    summary: summarise(results),
    results,
  };
}

// ---------------------------------------------------------------------------
// Background jobs
// ---------------------------------------------------------------------------

type BatchJobRow = typeof batchJobs.$inferSelect;

const EMPTY_PROGRESS: BatchProgress = {
  total: 0,
  done: 0,
  changed: 0,
  unchanged: 0,
  skipped: 0,
  failed: 0,
};

function toBatchJob(row: BatchJobRow): BatchJob {
  return {
    id: row.id,
    kind: "batch_counterfactual",
    status: row.status as BatchJobStatus,
    request: row.request as JsonObject,
    progress: { ...EMPTY_PROGRESS, ...(row.progress as Partial<BatchProgress>) },
    result: (row.result as JsonObject | null) ?? null,
    error: row.error,
    createdAt: iso(row.createdAt),
    startedAt: row.startedAt ? iso(row.startedAt) : null,
    finishedAt: row.finishedAt ? iso(row.finishedAt) : null,
  };
}

function now(ctx: ServiceContext): string {
  return iso(new Date(ctx.clock.now()));
}

async function updateJob(
  ctx: ServiceContext,
  jobId: string,
  patch: Partial<Omit<BatchJobRow, "id" | "kind" | "request" | "createdAt">>,
): Promise<void> {
  await ctx.handle.db.update(batchJobs).set(patch).where(eq(batchJobs.id, jobId));
}

/** Queue a batch counterfactual; the runner executes it after any earlier jobs. */
export async function startBatchJob(
  ctx: ServiceContext,
  body: BatchCounterfactualBody,
): Promise<BatchJob> {
  assertReplayable(ctx, body.agent);
  const row: BatchJobRow = {
    id: ctx.ids.next("job"),
    kind: "batch_counterfactual",
    status: "queued",
    request: toJson(body),
    progress: EMPTY_PROGRESS,
    result: null,
    error: null,
    createdAt: now(ctx),
    startedAt: null,
    finishedAt: null,
  };
  await ctx.handle.db.insert(batchJobs).values(row);
  ctx.jobs.enqueue(row.id, async (control) => {
    if (control.cancelled()) return;
    await updateJob(ctx, row.id, { status: "running", startedAt: now(ctx) });
    try {
      const result = await runBatchCounterfactual(ctx, body, {
        control,
        onProgress: (progress) => updateJob(ctx, row.id, { progress }),
      });
      await updateJob(ctx, row.id, {
        status: control.cancelled() ? "cancelled" : "completed",
        result: toJson(result),
        finishedAt: now(ctx),
      });
    } catch (error) {
      ctx.logger.error({ jobId: row.id, err: error }, "batch job failed");
      await updateJob(ctx, row.id, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        finishedAt: now(ctx),
      });
    }
  });
  return toBatchJob(row);
}

export async function getBatchJob(ctx: ServiceContext, jobId: string): Promise<BatchJob> {
  const [row] = await ctx.handle.db
    .select()
    .from(batchJobs)
    .where(eq(batchJobs.id, jobId))
    .limit(1);
  if (!row) throw ApiError.notFound("job", jobId);
  return toBatchJob(row);
}

/** Most recent jobs first; results are left out of the list to keep it small. */
export async function listBatchJobs(
  ctx: ServiceContext,
  query: { status?: BatchJobStatus; limit: number },
): Promise<BatchJob[]> {
  const rows = await ctx.handle.db
    .select()
    .from(batchJobs)
    .where(query.status ? eq(batchJobs.status, query.status) : undefined)
    .orderBy(desc(batchJobs.createdAt), desc(batchJobs.id))
    .limit(query.limit);
  return rows.map((row) => ({ ...toBatchJob(row), result: null }));
}

/**
 * Cancel a queued or running job. A queued job never starts; a running job stops before its
 * next trace and keeps the partial result. Finished jobs answer `409`.
 */
export async function cancelBatchJob(ctx: ServiceContext, jobId: string): Promise<BatchJob> {
  const job = await getBatchJob(ctx, jobId);
  if (job.status !== "queued" && job.status !== "running") {
    throw ApiError.conflict(`job ${jobId} is already ${job.status}`, { status: job.status });
  }
  const signalled = ctx.jobs.cancel(jobId);
  if (job.status === "queued" || !signalled) {
    await updateJob(ctx, jobId, { status: "cancelled", finishedAt: now(ctx) });
  }
  return getBatchJob(ctx, jobId);
}

/**
 * Jobs that were queued or running when the process stopped cannot resume (the runner is in
 * memory); mark them failed at startup so clients stop waiting.
 */
export async function failInterruptedJobs(ctx: ServiceContext): Promise<number> {
  const rows = await ctx.handle.db
    .update(batchJobs)
    .set({ status: "failed", error: "interrupted by an API restart", finishedAt: now(ctx) })
    .where(inArray(batchJobs.status, ["queued", "running"]))
    .returning({ id: batchJobs.id });
  return rows.length;
}
