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
