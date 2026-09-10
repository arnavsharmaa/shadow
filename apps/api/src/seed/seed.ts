import { VirtualClock, recordExecution, seededIdGenerator } from "@shadow/core";
import type { JsonValue, ShadowEvent } from "@shadow/schemas";
import { DEMO_PROJECT, demoTraces, type DemoTraceSpec } from "@shadow/testkit";
import { inArray } from "drizzle-orm";
import { traces } from "../db/schema.js";
import { createForkForTrace, runReplay } from "../services/branches.js";
import { createArtifact } from "../services/artifacts.js";
import { createComparison } from "../services/comparisons.js";
import type { ServiceContext } from "../services/context.js";
import { ingestEvents } from "../services/events.js";
import { ensureAgent, ensureProject } from "../services/projects.js";
import { createTrace } from "../services/traces.js";

export interface SeedOptions {
  /** Delete existing demo traces first. */
  force?: boolean;
}

export interface SeedReport {
  seeded: string[];
  skipped: string[];
}

/** True when the database holds no traces at all. */
export async function isDatabaseEmpty(ctx: ServiceContext): Promise<boolean> {
  const rows = await ctx.handle.db.select({ id: traces.id }).from(traces).limit(1);
  return rows.length === 0;
}

/**
 * Seed the deterministic demo data set: several recorded traces, one fork
 * with a counterfactual replay for the refund and inventory scenarios, and
 * their comparisons. Running it twice with the same database yields the same
 * ids, timestamps and metrics.
 */
export async function seedDemoData(
  base: ServiceContext,
  options: SeedOptions = {},
): Promise<SeedReport> {
  const ctx: ServiceContext = {
    ...base,
    ids: seededIdGenerator("shadow-demo-seed"),
    clock: new VirtualClock("2026-09-02T12:00:00.000Z"),
  };
  const report: SeedReport = { seeded: [], skipped: [] };
  const existing = await ctx.handle.db
    .select({ id: traces.id })
    .from(traces)
    .where(
      inArray(
        traces.id,
        demoTraces.map((t) => t.traceId),
      ),
    );
  const existingIds = new Set(existing.map((r) => r.id));
  if (options.force && existingIds.size > 0) {
    await ctx.handle.db.delete(traces).where(inArray(traces.id, [...existingIds]));
    existingIds.clear();
  }
  for (const spec of demoTraces) {
    if (existingIds.has(spec.traceId)) {
      report.skipped.push(spec.traceId);
      continue;
    }
    // A per-trace id generator keeps ids stable regardless of which traces
    // (or projects/agents) already exist in the database.
    await seedTrace({ ...ctx, ids: seededIdGenerator(`shadow-demo-seed:${spec.traceId}`) }, spec);
    report.seeded.push(spec.traceId);
  }
  ctx.logger.info(
    { seeded: report.seeded.length, skipped: report.skipped.length },
    "demo data seeded",
  );
  return report;
}

/** Store the body of every email the agent sent as an artifact linked to the send event. */
async function seedEmailArtifacts(
  ctx: ServiceContext,
  spec: DemoTraceSpec,
  events: readonly ShadowEvent[],
): Promise<void> {
  for (const event of events) {
    if (event.eventType !== "tool.response" || event.name !== "send_email") continue;
    const input = event.input as {
      arguments?: { to?: JsonValue; subject?: JsonValue; body?: JsonValue };
    };
    const args = input.arguments ?? {};
    await createArtifact(ctx, spec.traceId, {
      branchId: spec.rootBranchId,
      eventId: event.id,
      kind: "email",
      name: `email to ${String(args.to ?? "customer")}`,
      contentType: "text/plain",
      content: { to: args.to ?? null, subject: args.subject ?? null, body: args.body ?? null },
    });
  }
}

async function seedTrace(ctx: ServiceContext, spec: DemoTraceSpec): Promise<void> {
  const projectSlug = spec.project?.slug ?? DEMO_PROJECT.slug;
  const project = await ensureProject(ctx, {
    slug: projectSlug,
    name: spec.project?.name ?? DEMO_PROJECT.name,
    description: spec.project?.description ?? DEMO_PROJECT.description,
  });
  await ensureAgent(ctx, {
    projectId: project.id,
    slug: spec.agent.slug,
    name: spec.agent.name,
    description: spec.agent.description ?? null,
  });
  const recorded = await recordExecution({
    definition: spec.agent,
    input: spec.input,
    traceId: spec.traceId,
    branchId: spec.rootBranchId,
    traceName: spec.name,
    seed: spec.seed,
    startAt: spec.startAt,
    traceMetadata: spec.metadata,
    tags: spec.tags,
    source: "seed",
  });
  await createTrace(
    ctx,
    {
      id: spec.traceId,
      project: projectSlug,
      agent: spec.agent.slug,
      name: spec.name,
      startedAt: spec.startAt,
      tags: spec.tags,
      metadata: spec.metadata,
    },
    { rootBranchId: spec.rootBranchId },
  );
  await ingestEvents(ctx, spec.traceId, { branchId: spec.rootBranchId, events: recorded.events });
  await seedEmailArtifacts(ctx, spec, recorded.events);
  if (!spec.fork) return;
  const wanted = spec.fork.selectEvent;
  let seen = 0;
  const target = recorded.events.find((e) => {
    if (e.eventType !== wanted.eventType || e.name !== wanted.name) return false;
    seen++;
    return seen === (wanted.occurrence ?? 1);
  });
  if (!target)
    throw new Error(
      `seed: fork target ${wanted.eventType} ${wanted.name} not found in ${spec.traceId}`,
    );
  const { branch } = await createForkForTrace(ctx, spec.traceId, {
    forkEventId: target.id,
    parentBranchId: spec.rootBranchId,
    name: spec.fork.name,
    overrides: spec.fork.overrides,
  });
  const { replay } = await runReplay(ctx, branch.id, "deterministic");
  if (replay.status !== "completed")
    throw new Error(`seed: replay for ${spec.traceId} failed: ${replay.error}`);
  await createComparison(ctx, { baseBranchId: spec.rootBranchId, targetBranchId: branch.id });
}
