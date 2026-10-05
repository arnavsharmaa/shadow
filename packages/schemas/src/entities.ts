import { z } from "zod";
import { outcomeSchema } from "./events.js";
import { idSchema } from "./ids.js";
import { jsonObjectSchema, jsonValueSchema } from "./json.js";
import { overrideSchema } from "./overrides.js";
import { schemaVersionSchema } from "./version.js";

const timestamp = z.iso.datetime({ offset: true });

export const projectSchema = z.object({
  id: idSchema,
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "slug must be lowercase letters, digits and dashes"),
  name: z.string().min(1).max(128),
  description: z.string().max(2000).nullable().default(null),
  createdAt: timestamp,
  updatedAt: timestamp,
  metadata: jsonObjectSchema.default({}),
});
export type Project = z.infer<typeof projectSchema>;

export const agentSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  slug: z.string().min(1).max(64),
  name: z.string().min(1).max(128),
  description: z.string().max(2000).nullable().default(null),
  /** Whether a deterministic program is registered for counterfactual replay. */
  replayable: z.boolean().default(false),
  createdAt: timestamp,
  metadata: jsonObjectSchema.default({}),
});
export type Agent = z.infer<typeof agentSchema>;

export const TRACE_STATUSES = ["running", "completed", "failed"] as const;
export const traceStatusSchema = z.enum(TRACE_STATUSES);
export type TraceStatus = z.infer<typeof traceStatusSchema>;

/** Aggregated usage and cost for a branch (the "CostRecord"). */
export const branchMetricsSchema = z.object({
  eventCount: z.number().int().nonnegative().default(0),
  modelCalls: z.number().int().nonnegative().default(0),
  toolCalls: z.number().int().nonnegative().default(0),
  toolErrors: z.number().int().nonnegative().default(0),
  policyEvaluations: z.number().int().nonnegative().default(0),
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  totalTokens: z.number().int().nonnegative().default(0),
  estimatedModelCost: z.number().nonnegative().default(0),
  estimatedToolCost: z.number().nonnegative().default(0),
  totalEstimatedCost: z.number().nonnegative().default(0),
  durationMs: z.number().nonnegative().default(0),
  currency: z.string().length(3).default("USD"),
  /** Earliest/latest event timestamps; let metrics be merged incrementally. */
  firstTimestamp: z.string().nullable().default(null),
  lastTimestamp: z.string().nullable().default(null),
});
export type BranchMetrics = z.infer<typeof branchMetricsSchema>;

export function emptyBranchMetrics(): BranchMetrics {
  return {
    eventCount: 0,
    modelCalls: 0,
    toolCalls: 0,
    toolErrors: 0,
    policyEvaluations: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedModelCost: 0,
    estimatedToolCost: 0,
    totalEstimatedCost: 0,
    durationMs: 0,
    currency: "USD",
    firstTimestamp: null,
    lastTimestamp: null,
  };
}

export const BRANCH_STATUSES = [
  "recording",
  "pending",
  "replaying",
  "completed",
  "failed",
] as const;
export const branchStatusSchema = z.enum(BRANCH_STATUSES);
export type BranchStatus = z.infer<typeof branchStatusSchema>;

export const branchSchema = z.object({
  id: idSchema,
  traceId: idSchema,
  name: z.string().min(1).max(128),
  parentBranchId: idSchema.nullable().default(null),
  forkId: idSchema.nullable().default(null),
  /** Event in the parent lineage after which this branch diverges. */
  forkEventId: idSchema.nullable().default(null),
  forkSequence: z.number().int().nonnegative().nullable().default(null),
  /** Depth in the branch tree (root = 0). */
  depth: z.number().int().nonnegative().default(0),
  status: branchStatusSchema,
  outcome: outcomeSchema.nullable().default(null),
  metrics: branchMetricsSchema.default(() => emptyBranchMetrics()),
  createdAt: timestamp,
  updatedAt: timestamp,
  metadata: jsonObjectSchema.default({}),
});
export type Branch = z.infer<typeof branchSchema>;

export const traceSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  agentId: idSchema,
  rootBranchId: idSchema,
  name: z.string().min(1).max(256),
  status: traceStatusSchema,
  schemaVersion: schemaVersionSchema,
  startedAt: timestamp,
  completedAt: timestamp.nullable().default(null),
  durationMs: z.number().nonnegative().nullable().default(null),
  outcome: outcomeSchema.nullable().default(null),
  tags: z.array(z.string().max(64)).max(64).default([]),
  metadata: jsonObjectSchema.default({}),
  metrics: branchMetricsSchema.default(() => emptyBranchMetrics()),
  branchCount: z.number().int().nonnegative().default(1),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type Trace = z.infer<typeof traceSchema>;

/** Trace joined with project/agent names for list views. */
export const traceSummarySchema = traceSchema.extend({
  projectSlug: z.string(),
  projectName: z.string(),
  agentSlug: z.string(),
  agentName: z.string(),
});
export type TraceSummary = z.infer<typeof traceSummarySchema>;

export const forkSchema = z.object({
  id: idSchema,
  traceId: idSchema,
  parentBranchId: idSchema,
  childBranchId: idSchema,
  forkEventId: idSchema,
  forkSequence: z.number().int().nonnegative(),
  overrides: z.array(overrideSchema).max(200),
  createdAt: timestamp,
  metadata: jsonObjectSchema.default({}),
});
export type Fork = z.infer<typeof forkSchema>;

export const REPLAY_MODES = ["historical", "deterministic", "live"] as const;
export const replayModeSchema = z.enum(REPLAY_MODES);
export type ReplayMode = z.infer<typeof replayModeSchema>;

export const REPLAY_STATUSES = ["pending", "running", "completed", "failed"] as const;
export const replayStatusSchema = z.enum(REPLAY_STATUSES);
export type ReplayStatus = z.infer<typeof replayStatusSchema>;

export const replaySchema = z.object({
  id: idSchema,
  traceId: idSchema,
  branchId: idSchema,
  forkId: idSchema.nullable().default(null),
  mode: replayModeSchema,
  status: replayStatusSchema,
  startedAt: timestamp,
  completedAt: timestamp.nullable().default(null),
  eventCount: z.number().int().nonnegative().default(0),
  error: z.string().max(4000).nullable().default(null),
  metadata: jsonObjectSchema.default({}),
});
export type Replay = z.infer<typeof replaySchema>;

export const artifactSchema = z.object({
  id: idSchema,
  traceId: idSchema,
  branchId: idSchema,
  eventId: idSchema.nullable().default(null),
  kind: z.string().max(64),
  name: z.string().max(256),
  contentType: z.string().max(128),
  content: jsonValueSchema,
  createdAt: timestamp,
});
export type Artifact = z.infer<typeof artifactSchema>;

/** A named trace-explorer filter set stored on the server and shared by everyone using the API. */
export const savedViewSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(64),
  /** Explorer query string (the trace list filters and sort), without `cursor` or `limit`. */
  query: z.string().max(2048),
  description: z.string().max(500).nullable().default(null),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type SavedView = z.infer<typeof savedViewSchema>;

export const BATCH_JOB_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;
export const batchJobStatusSchema = z.enum(BATCH_JOB_STATUSES);
export type BatchJobStatus = z.infer<typeof batchJobStatusSchema>;

/** A batch counterfactual running in the background (`background: true`). */
export const batchJobSchema = z.object({
  id: idSchema,
  kind: z.literal("batch_counterfactual"),
  status: batchJobStatusSchema,
  /** The validated request body. */
  request: jsonObjectSchema,
  progress: z.object({
    total: z.number().int().nonnegative(),
    done: z.number().int().nonnegative(),
    changed: z.number().int().nonnegative(),
    unchanged: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
  /** The batch result once finished (partial for a cancelled job), otherwise `null`. */
  result: jsonObjectSchema.nullable(),
  error: z.string().nullable(),
  createdAt: timestamp,
  startedAt: timestamp.nullable(),
  finishedAt: timestamp.nullable(),
});
export type BatchJob = z.infer<typeof batchJobSchema>;

/** Actions the API records in the audit log; the column is an open string for the future. */
export const AUDIT_ACTIONS = [
  "trace.updated",
  "trace.deleted",
  "trace.imported",
  "traces.pruned",
  "fork.created",
  "matrix.run",
  "replay.run",
  "branch.updated",
  "branch.deleted",
  "comparison.created",
  "artifact.created",
  "batch.run",
  "batch.queued",
  "batch.cancelled",
  "view.saved",
  "view.deleted",
  "share.created",
  "share.revoked",
  "alert.created",
  "alert.updated",
  "alert.deleted",
  "collection.created",
  "collection.updated",
  "collection.deleted",
  "collection.traces_added",
  "collection.traces_removed",
  "key.created",
  "key.revoked",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** Who did what to which resource; written by the API for every state-changing request. */
export const auditEntrySchema = z.object({
  id: idSchema,
  at: timestamp,
  /** Self-reported by the client (`x-shadow-actor`), or `system:<task>` for background work. */
  actor: z.string().max(128),
  action: z.string().max(64),
  targetType: z.string().max(32),
  targetId: z.string().max(128),
  traceId: idSchema.nullable(),
  details: jsonObjectSchema,
  requestId: z.string().max(128).nullable(),
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;

/** A read-only link to one trace; the token itself is only returned when it is created. */
export const traceShareSchema = z.object({
  id: idSchema,
  traceId: idSchema,
  note: z.string().max(500).nullable(),
  createdAt: timestamp,
  expiresAt: timestamp,
  revokedAt: timestamp.nullable(),
  accessCount: z.number().int().nonnegative(),
  lastAccessedAt: timestamp.nullable(),
});
export type TraceShare = z.infer<typeof traceShareSchema>;

/**
 * What an alert rule measures over traces started inside its window:
 * - `failure_rate`: failed traces divided by finished traces (0 to 1)
 * - `policy_violations`: traces whose outcome is a policy violation
 * - `tool_errors`: failed tool calls, summed
 * - `total_cost`: estimated cost, summed
 * - `p95_duration_ms`: 95th percentile trace duration
 */
export const ALERT_METRICS = [
  "failure_rate",
  "policy_violations",
  "tool_errors",
  "total_cost",
  "p95_duration_ms",
] as const;
export const alertMetricSchema = z.enum(ALERT_METRICS);
export type AlertMetric = z.infer<typeof alertMetricSchema>;

export const ALERT_MODES = ["threshold", "baseline"] as const;

/**
 * A rule on one metric. In `threshold` mode it fires while the value is at or above
 * `threshold`. In `baseline` mode `threshold` is a multiplier: it fires while the value is at
 * or above `threshold` times the metric's own baseline, measured over the `baselineWindows`
 * windows immediately before the current one.
 */
export const alertRuleSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(128),
  mode: z.enum(ALERT_MODES),
  baselineWindows: z.number().int().positive(),
  /** The baseline the last evaluation compared against (baseline mode only). */
  lastBaseline: z.number().nullable(),
  /** Agent slug the rule is scoped to, or `null` for every agent. */
  agent: z.string().max(64).nullable(),
  project: z.string().max(64).nullable(),
  metric: alertMetricSchema,
  threshold: z.number().nonnegative(),
  windowMinutes: z.number().int().positive(),
  /** Traces needed in the window before the rule can fire (guards small samples). */
  minTraces: z.number().int().positive(),
  enabled: z.boolean(),
  state: z.enum(["ok", "firing"]),
  lastValue: z.number().nullable(),
  lastTraces: z.number().int().nonnegative().nullable(),
  lastEvaluatedAt: timestamp.nullable(),
  /** When the rule last went from ok to firing. */
  lastTriggeredAt: timestamp.nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type AlertRule = z.infer<typeof alertRuleSchema>;

/** A named group of related traces: an incident, an experiment, a batch, a review queue. */
export const collectionSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(64),
  description: z.string().max(500).nullable(),
  traceCount: z.number().int().nonnegative(),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type Collection = z.infer<typeof collectionSchema>;

/**
 * What an API key may do: `ingest` records traces (create, events, updates, artifacts and
 * imports), `read` reads everything, `admin` does anything the API token can.
 */
export const API_KEY_SCOPES = ["ingest", "read", "admin"] as const;
export const apiKeyScopeSchema = z.enum(API_KEY_SCOPES);
export type ApiKeyScope = z.infer<typeof apiKeyScopeSchema>;

/** An API key; the secret is shown once, on creation, and only its hash is stored. */
export const apiKeySchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(64),
  scope: apiKeyScopeSchema,
  /** Project slug an `ingest` key is pinned to; `null` lets it record into any project. */
  project: z.string().max(64).nullable(),
  /** The first characters of the secret, to tell keys apart in logs and lists. */
  prefix: z.string().max(16),
  createdAt: timestamp,
  lastUsedAt: timestamp.nullable(),
  revokedAt: timestamp.nullable(),
});
export type ApiKey = z.infer<typeof apiKeySchema>;
