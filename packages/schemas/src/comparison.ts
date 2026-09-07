import { z } from "zod";
import { branchMetricsSchema } from "./entities.js";
import { outcomeSchema, policyDecisionSchema } from "./events.js";
import { idSchema } from "./ids.js";
import { jsonValueSchema } from "./json.js";
import { overrideSchema } from "./overrides.js";
import { diffEntrySchema } from "./state.js";

export const eventRefSchema = z.object({
  id: idSchema,
  branchId: idSchema,
  sequence: z.number().int().nonnegative(),
  eventType: z.string(),
  name: z.string(),
  timestamp: z.string(),
  durationMs: z.number().nullable().default(null),
});
export type EventRef = z.infer<typeof eventRefSchema>;

export const fieldDiffSchema = z.object({
  /** Dotted path within the event, e.g. `output.decision`. */
  path: z.string(),
  before: jsonValueSchema.optional(),
  after: jsonValueSchema.optional(),
});
export type FieldDiff = z.infer<typeof fieldDiffSchema>;

export const DIVERGENCE_REASONS = [
  "type_changed",
  "name_changed",
  "input_changed",
  "output_changed",
  "event_added",
  "event_removed",
] as const;
export const divergenceReasonSchema = z.enum(DIVERGENCE_REASONS);
export type DivergenceReason = z.infer<typeof divergenceReasonSchema>;

export const firstDivergenceSchema = z.object({
  /** Position (0-based) in the aligned step list. */
  stepIndex: z.number().int().nonnegative(),
  /** Sequence of the diverging event in the base branch lineage, if present. */
  sequence: z.number().int().nonnegative(),
  reason: divergenceReasonSchema,
  summary: z.string(),
  base: eventRefSchema.nullable(),
  target: eventRefSchema.nullable(),
  fields: z.array(fieldDiffSchema),
});
export type FirstDivergence = z.infer<typeof firstDivergenceSchema>;

export const ALIGNED_STEP_KINDS = [
  "shared",
  "same",
  "modified",
  "added",
  "removed",
  "override",
] as const;
export const alignedStepSchema = z.object({
  index: z.number().int().nonnegative(),
  kind: z.enum(ALIGNED_STEP_KINDS),
  base: eventRefSchema.nullable(),
  target: eventRefSchema.nullable(),
  fields: z.array(fieldDiffSchema).default([]),
});
export type AlignedStep = z.infer<typeof alignedStepSchema>;

export const deltaSchema = z.object({
  base: z.number(),
  target: z.number(),
  delta: z.number(),
  /** Relative change; null when base is 0. */
  percent: z.number().nullable(),
});
export type Delta = z.infer<typeof deltaSchema>;

export const toolCallSummarySchema = z.object({
  eventId: idSchema,
  sequence: z.number().int().nonnegative(),
  tool: z.string(),
  arguments: jsonValueSchema.optional(),
  result: jsonValueSchema.optional(),
  error: jsonValueSchema.optional(),
  status: z.enum(["ok", "error"]),
  durationMs: z.number().nullable(),
});
export type ToolCallSummary = z.infer<typeof toolCallSummarySchema>;

export const toolCallDiffSchema = z.object({
  tool: z.string(),
  kind: z.enum(["arguments", "result", "added", "removed", "status"]),
  base: toolCallSummarySchema.nullable(),
  target: toolCallSummarySchema.nullable(),
  fields: z.array(fieldDiffSchema),
});
export type ToolCallDiff = z.infer<typeof toolCallDiffSchema>;

export const policyDecisionSummarySchema = z.object({
  eventId: idSchema,
  sequence: z.number().int().nonnegative(),
  policy: z.string(),
  decision: policyDecisionSchema,
  reason: z.string().optional(),
});
export const policyCountsSchema = z.object({
  allow: z.number().int().nonnegative(),
  deny: z.number().int().nonnegative(),
  approval_required: z.number().int().nonnegative(),
});

export const comparisonSideSchema = z.object({
  branchId: idSchema,
  name: z.string(),
  metrics: branchMetricsSchema,
  outcome: outcomeSchema.nullable(),
  eventCount: z.number().int().nonnegative(),
});

/** Structured comparison of two branches, shared by API and web. */
export const comparisonResultSchema = z.object({
  base: comparisonSideSchema,
  target: comparisonSideSchema,
  /** Sequence of the last event shared by both lineages (null = unrelated). */
  sharedUntilSequence: z.number().int().min(-1),
  overrides: z.array(overrideSchema),
  firstDivergence: firstDivergenceSchema.nullable(),
  steps: z.array(alignedStepSchema),
  addedEvents: z.array(eventRefSchema),
  removedEvents: z.array(eventRefSchema),
  modifiedEvents: z.array(
    z.object({ base: eventRefSchema, target: eventRefSchema, fields: z.array(fieldDiffSchema) }),
  ),
  toolCalls: z.object({
    base: z.array(toolCallSummarySchema),
    target: z.array(toolCallSummarySchema),
    diffs: z.array(toolCallDiffSchema),
  }),
  context: z.object({ diff: z.array(diffEntrySchema) }),
  state: z.object({ diff: z.array(diffEntrySchema) }),
  metrics: z.object({
    totalTokens: deltaSchema,
    inputTokens: deltaSchema,
    outputTokens: deltaSchema,
    totalEstimatedCost: deltaSchema,
    durationMs: deltaSchema,
    toolCalls: deltaSchema,
    modelCalls: deltaSchema,
    eventCount: deltaSchema,
  }),
  outcome: z.object({
    base: outcomeSchema.nullable(),
    target: outcomeSchema.nullable(),
    changed: z.boolean(),
  }),
  policy: z.object({
    base: policyCountsSchema,
    target: policyCountsSchema,
    baseDecisions: z.array(policyDecisionSummarySchema),
    targetDecisions: z.array(policyDecisionSummarySchema),
    changed: z.boolean(),
  }),
});
export type ComparisonResult = z.infer<typeof comparisonResultSchema>;

export const comparisonSchema = z.object({
  id: idSchema,
  traceId: idSchema,
  baseBranchId: idSchema,
  targetBranchId: idSchema,
  createdAt: z.iso.datetime({ offset: true }),
  result: comparisonResultSchema,
});
export type Comparison = z.infer<typeof comparisonSchema>;
