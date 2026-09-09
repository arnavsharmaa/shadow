import type { Artifact, JsonValue } from "@shadow/schemas";
import { and, asc, eq, type SQL } from "drizzle-orm";
import { artifacts, events } from "../db/schema.js";
import { ApiError } from "../errors.js";
import type { ServiceContext } from "./context.js";
import { getBranchRow } from "./events.js";
import { iso, toArtifact } from "./mappers.js";
import { getTraceRow } from "./traces.js";

export interface CreateArtifactInput {
  branchId?: string;
  eventId?: string;
  kind: string;
  name: string;
  contentType: string;
  content: JsonValue;
}

/** Attach a document (email body, retrieved file, report) to a trace, branch or event. */
export async function createArtifact(
  ctx: ServiceContext,
  traceId: string,
  input: CreateArtifactInput,
): Promise<Artifact> {
  const trace = await getTraceRow(ctx, traceId);
  const branchId = input.branchId ?? trace.rootBranchId;
  const branch = await getBranchRow(ctx, branchId);
  if (branch.traceId !== traceId) {
    throw ApiError.badRequest(`branch ${branchId} does not belong to trace ${traceId}`);
  }
  if (input.eventId) {
    const [event] = await ctx.handle.db
      .select({ id: events.id })
      .from(events)
      .where(and(eq(events.traceId, traceId), eq(events.id, input.eventId)))
      .limit(1);
    if (!event) throw ApiError.notFound("event", input.eventId);
  }
  const row = {
    id: ctx.ids.next("art"),
    traceId,
    branchId,
    eventId: input.eventId ?? null,
    kind: input.kind,
    name: input.name,
    contentType: input.contentType,
    content: ctx.redactor.redact(input.content),
    createdAt: iso(new Date(ctx.clock.now())),
  };
  await ctx.handle.db.insert(artifacts).values(row);
  return toArtifact(row);
}

export async function listArtifacts(
  ctx: ServiceContext,
  traceId: string,
  query: { branchId?: string; eventId?: string; limit: number },
): Promise<Artifact[]> {
  await getTraceRow(ctx, traceId);
  const filters: SQL[] = [eq(artifacts.traceId, traceId)];
  if (query.branchId) filters.push(eq(artifacts.branchId, query.branchId));
  if (query.eventId) filters.push(eq(artifacts.eventId, query.eventId));
  const rows = await ctx.handle.db
    .select()
    .from(artifacts)
    .where(and(...filters))
    .orderBy(asc(artifacts.createdAt), asc(artifacts.id))
    .limit(query.limit);
  return rows.map(toArtifact);
}

export async function getArtifact(
  ctx: ServiceContext,
  traceId: string,
  artifactId: string,
): Promise<Artifact> {
  const [row] = await ctx.handle.db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.traceId, traceId), eq(artifacts.id, artifactId)))
    .limit(1);
  if (!row) throw ApiError.notFound("artifact", artifactId);
  return toArtifact(row);
}
