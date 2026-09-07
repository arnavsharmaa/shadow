import type {
  Agent,
  Branch,
  BranchMetrics,
  Comparison,
  ComparisonResult,
  EstimatedCost,
  Fork,
  JsonObject,
  JsonValue,
  Outcome,
  Override,
  Project,
  Replay,
  ShadowEvent,
  TokenUsage,
  Trace,
  TraceSummary,
  Artifact,
} from "@shadow/schemas";
import { emptyBranchMetrics } from "@shadow/schemas";
import type { InferSelectModel } from "drizzle-orm";
import type {
  agents,
  artifacts,
  branches,
  comparisons,
  events,
  forks,
  projects,
  replays,
  traces,
} from "../db/schema.js";

export type ProjectRow = InferSelectModel<typeof projects>;
export type AgentRow = InferSelectModel<typeof agents>;
export type TraceRow = InferSelectModel<typeof traces>;
export type BranchRow = InferSelectModel<typeof branches>;
export type EventRow = InferSelectModel<typeof events>;
export type ForkRow = InferSelectModel<typeof forks>;
export type ReplayRow = InferSelectModel<typeof replays>;
export type ComparisonRow = InferSelectModel<typeof comparisons>;
export type ArtifactRow = InferSelectModel<typeof artifacts>;

/** Database drivers return timestamps in Postgres text form; normalise to ISO. */
export function iso(value: string | Date | null | undefined): string {
  if (value === null || value === undefined) return new Date(0).toISOString();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

export function isoOrNull(value: string | Date | null | undefined): string | null {
  return value === null || value === undefined ? null : iso(value);
}

function obj(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    metadata: obj(row.metadata),
  };
}

export function toAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    projectId: row.projectId,
    slug: row.slug,
    name: row.name,
    description: row.description,
    replayable: row.replayable,
    createdAt: iso(row.createdAt),
    metadata: obj(row.metadata),
  };
}

export function toMetrics(value: unknown): BranchMetrics {
  return { ...emptyBranchMetrics(), ...obj(value) } as BranchMetrics;
}

export function toTrace(row: TraceRow): Trace {
  return {
    id: row.id,
    projectId: row.projectId,
    agentId: row.agentId,
    rootBranchId: row.rootBranchId,
    name: row.name,
    status: row.status as Trace["status"],
    schemaVersion: row.schemaVersion,
    startedAt: iso(row.startedAt),
    completedAt: isoOrNull(row.completedAt),
    durationMs: row.durationMs,
    outcome: (row.outcome as Outcome | null) ?? null,
    tags: strings(row.tags),
    metadata: obj(row.metadata),
    metrics: toMetrics(row.metrics),
    branchCount: row.branchCount,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function toTraceSummary(row: TraceRow, project: ProjectRow, agent: AgentRow): TraceSummary {
  return {
    ...toTrace(row),
    projectSlug: project.slug,
    projectName: project.name,
    agentSlug: agent.slug,
    agentName: agent.name,
  };
}

export function toBranch(row: BranchRow): Branch {
  return {
    id: row.id,
    traceId: row.traceId,
    name: row.name,
    parentBranchId: row.parentBranchId,
    forkId: row.forkId,
    forkEventId: row.forkEventId,
    forkSequence: row.forkSequence,
    depth: row.depth,
    status: row.status as Branch["status"],
    outcome: (row.outcome as Outcome | null) ?? null,
    metrics: toMetrics(row.metrics),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    metadata: obj(row.metadata),
  };
}

export function toEvent(row: EventRow): ShadowEvent {
  const event: ShadowEvent = {
    ...(obj(row.extra) as Record<string, JsonValue>),
    id: row.id,
    schemaVersion: row.schemaVersion,
    traceId: row.traceId,
    branchId: row.branchId,
    parentEventId: row.parentEventId,
    spanId: row.spanId,
    parentSpanId: row.parentSpanId,
    sequence: row.sequence,
    timestamp: iso(row.timestamp),
    durationMs: row.durationMs,
    eventType: row.eventType,
    source: row.source,
    severity: row.severity as ShadowEvent["severity"],
    name: row.name,
    metadata: obj(row.metadata),
    tags: strings(row.tags),
    tokenUsage: (row.tokenUsage as TokenUsage | null) ?? null,
    estimatedCost: (row.estimatedCost as EstimatedCost | null) ?? null,
    stateVersion: row.stateVersion,
    correlationId: row.correlationId,
  };
  if (row.input !== null && row.input !== undefined) event.input = row.input as JsonValue;
  if (row.output !== null && row.output !== undefined) event.output = row.output as JsonValue;
  return event;
}

const KNOWN_EVENT_KEYS = new Set([
  "id",
  "schemaVersion",
  "traceId",
  "branchId",
  "parentEventId",
  "spanId",
  "parentSpanId",
  "sequence",
  "timestamp",
  "durationMs",
  "eventType",
  "source",
  "severity",
  "name",
  "input",
  "output",
  "metadata",
  "tags",
  "tokenUsage",
  "estimatedCost",
  "stateVersion",
  "correlationId",
]);

export function toEventRow(event: ShadowEvent): typeof events.$inferInsert {
  const extra: JsonObject = {};
  for (const [key, value] of Object.entries(event)) {
    if (!KNOWN_EVENT_KEYS.has(key) && value !== undefined) extra[key] = value as JsonValue;
  }
  return {
    id: event.id,
    schemaVersion: event.schemaVersion,
    traceId: event.traceId,
    branchId: event.branchId,
    parentEventId: event.parentEventId ?? null,
    spanId: event.spanId ?? null,
    parentSpanId: event.parentSpanId ?? null,
    sequence: event.sequence,
    timestamp: event.timestamp,
    durationMs: event.durationMs ?? null,
    eventType: event.eventType,
    source: event.source,
    severity: event.severity,
    name: event.name,
    input: event.input === undefined ? null : event.input,
    output: event.output === undefined ? null : event.output,
    metadata: event.metadata,
    tags: event.tags,
    tokenUsage: event.tokenUsage ?? null,
    estimatedCost: event.estimatedCost ?? null,
    stateVersion: event.stateVersion ?? null,
    correlationId: event.correlationId ?? null,
    extra: Object.keys(extra).length > 0 ? extra : null,
  };
}

export function toFork(row: ForkRow): Fork {
  return {
    id: row.id,
    traceId: row.traceId,
    parentBranchId: row.parentBranchId,
    childBranchId: row.childBranchId,
    forkEventId: row.forkEventId,
    forkSequence: row.forkSequence,
    overrides: (row.overrides as Override[]) ?? [],
    createdAt: iso(row.createdAt),
    metadata: obj(row.metadata),
  };
}

export function toReplay(row: ReplayRow): Replay {
  return {
    id: row.id,
    traceId: row.traceId,
    branchId: row.branchId,
    forkId: row.forkId,
    mode: row.mode as Replay["mode"],
    status: row.status as Replay["status"],
    startedAt: iso(row.startedAt),
    completedAt: isoOrNull(row.completedAt),
    eventCount: row.eventCount,
    error: row.error,
    metadata: obj(row.metadata),
  };
}

export function toComparison(row: ComparisonRow): Comparison {
  return {
    id: row.id,
    traceId: row.traceId,
    baseBranchId: row.baseBranchId,
    targetBranchId: row.targetBranchId,
    createdAt: iso(row.createdAt),
    result: row.result as ComparisonResult,
  };
}

export function toArtifact(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    traceId: row.traceId,
    branchId: row.branchId,
    eventId: row.eventId,
    kind: row.kind,
    name: row.name,
    contentType: row.contentType,
    content: row.content as JsonValue,
    createdAt: iso(row.createdAt),
  };
}
