import { z } from "zod";
import { idSchema } from "./ids.js";
import { jsonObjectSchema, jsonValueSchema } from "./json.js";
import { SCHEMA_VERSION, schemaVersionSchema } from "./version.js";

/**
 * Event types Shadow understands natively. The `eventType` field itself is an
 * open string (`category.action`) so integrations may introduce their own
 * types (for example `langgraph.node_entered`) without breaking old readers.
 */
export const EVENT_TYPES = [
  "trace.started",
  "trace.completed",
  "trace.failed",
  "agent.started",
  "agent.completed",
  "agent.note",
  "model.request",
  "model.response",
  "tool.request",
  "tool.response",
  "tool.error",
  "state.snapshot",
  "state.patch",
  "context.added",
  "context.removed",
  "policy.evaluated",
  "policy.allowed",
  "policy.denied",
  "policy.approval_required",
  "human.approval_requested",
  "human.approval_resolved",
  "replay.started",
  "replay.completed",
  "replay.failed",
  "fork.created",
] as const;

export type KnownEventType = (typeof EVENT_TYPES)[number];

export const eventTypeSchema = z
  .string()
  .min(3)
  .max(96)
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, "eventType must look like `category.action`");

export type EventType = KnownEventType | (string & {});

export function isKnownEventType(type: string): type is KnownEventType {
  return (EVENT_TYPES as readonly string[]).includes(type);
}

export const EVENT_SOURCES = ["sdk", "api", "replay", "import", "seed"] as const;
export const eventSourceSchema = z.string().min(1).max(64);

export const SEVERITIES = ["debug", "info", "warn", "error"] as const;
export const severitySchema = z.enum(SEVERITIES);
export type Severity = z.infer<typeof severitySchema>;

export const tokenUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
});
export type TokenUsage = z.infer<typeof tokenUsageSchema>;

/** Costs are always *estimates* derived from a pricing table. */
export const estimatedCostSchema = z.object({
  amount: z.number().nonnegative(),
  currency: z.string().length(3).default("USD"),
  provider: z.string().max(64).optional(),
  model: z.string().max(128).optional(),
  pricingVersion: z.string().max(64).optional(),
});
export type EstimatedCost = z.infer<typeof estimatedCostSchema>;

/** Reserved metadata namespace written by Shadow itself. */
export const shadowMetadataSchema = z.looseObject({
  origin: z.enum(["recorded", "replay", "override", "import", "seed"]).optional(),
  replayId: idSchema.optional(),
  forkId: idSchema.optional(),
  /** Event in the parent lineage this replayed event corresponds to. */
  correspondsTo: idSchema.optional(),
  overrideId: z.string().max(128).optional(),
  overrideKind: z.string().max(64).optional(),
  /** Set on tool responses/errors whose result came from an override. */
  overrideApplied: z.boolean().optional(),
  scenario: z.string().max(128).optional(),
});
export type ShadowMetadata = z.infer<typeof shadowMetadataSchema>;

/**
 * Canonical event. This is the unit stored in the append-only event log and
 * exchanged over the ingestion API. Unknown top-level fields are preserved.
 */
export const eventSchema = z.looseObject({
  id: idSchema,
  schemaVersion: schemaVersionSchema.default(SCHEMA_VERSION),
  traceId: idSchema,
  branchId: idSchema,
  parentEventId: idSchema.nullable().default(null),
  spanId: idSchema.nullable().default(null),
  parentSpanId: idSchema.nullable().default(null),
  sequence: z.number().int().nonnegative(),
  timestamp: z.iso.datetime({ offset: true }),
  durationMs: z.number().nonnegative().nullable().default(null),
  eventType: eventTypeSchema,
  source: eventSourceSchema.default("sdk"),
  severity: severitySchema.default("info"),
  name: z.string().min(1).max(256),
  input: jsonValueSchema.optional(),
  output: jsonValueSchema.optional(),
  metadata: jsonObjectSchema.default({}),
  tags: z.array(z.string().min(1).max(64)).max(64).default([]),
  tokenUsage: tokenUsageSchema.nullable().default(null),
  estimatedCost: estimatedCostSchema.nullable().default(null),
  stateVersion: z.number().int().nonnegative().nullable().default(null),
  correlationId: z.string().max(128).nullable().default(null),
});

export type ShadowEvent = z.infer<typeof eventSchema>;
export type ShadowEventInput = z.input<typeof eventSchema>;

/**
 * Event as accepted by the ingestion API: the server fills ids, sequence,
 * timestamps and trace/branch ids when they are omitted.
 */
export const ingestEventSchema = eventSchema
  .omit({ id: true, traceId: true, branchId: true, sequence: true, timestamp: true })
  .extend({
    id: idSchema.optional(),
    branchId: idSchema.optional(),
    sequence: z.number().int().nonnegative().optional(),
    timestamp: z.iso.datetime({ offset: true }).optional(),
  });
export type IngestEvent = z.infer<typeof ingestEventSchema>;
export type IngestEventInput = z.input<typeof ingestEventSchema>;

// ---------------------------------------------------------------------------
// Typed payloads for well-known event types. They are deliberately lenient
// (`looseObject`) so producers can attach extra data.
// ---------------------------------------------------------------------------

export const modelMessageSchema = z.looseObject({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: jsonValueSchema,
  name: z.string().optional(),
});
export type ModelMessage = z.infer<typeof modelMessageSchema>;

export const modelRequestPayloadSchema = z.looseObject({
  provider: z.string().max(64),
  model: z.string().max(128),
  messages: z.array(modelMessageSchema),
  parameters: jsonObjectSchema.optional(),
});
export type ModelRequestPayload = z.infer<typeof modelRequestPayloadSchema>;

export const modelResponsePayloadSchema = z.looseObject({
  message: modelMessageSchema,
  finishReason: z.string().max(64).optional(),
  toolCalls: z.array(z.looseObject({ tool: z.string(), arguments: jsonValueSchema })).optional(),
});
export type ModelResponsePayload = z.infer<typeof modelResponsePayloadSchema>;

export const toolRequestPayloadSchema = z.looseObject({
  tool: z.string().max(128),
  arguments: jsonValueSchema,
});
export type ToolRequestPayload = z.infer<typeof toolRequestPayloadSchema>;

export const toolResponsePayloadSchema = z.looseObject({
  result: jsonValueSchema,
});
export type ToolResponsePayload = z.infer<typeof toolResponsePayloadSchema>;

export const toolErrorPayloadSchema = z.looseObject({
  error: z.looseObject({
    message: z.string(),
    code: z.string().max(64).optional(),
    retryable: z.boolean().optional(),
  }),
});
export type ToolErrorPayload = z.infer<typeof toolErrorPayloadSchema>;

export const POLICY_DECISIONS = ["allow", "deny", "approval_required"] as const;
export const policyDecisionSchema = z.enum(POLICY_DECISIONS);
export type PolicyDecision = z.infer<typeof policyDecisionSchema>;

export const policyEvaluationPayloadSchema = z.looseObject({
  policy: z.string().max(128),
  decision: policyDecisionSchema,
  reason: z.string().max(2000).optional(),
  subject: jsonValueSchema.optional(),
  details: jsonObjectSchema.optional(),
});
export type PolicyEvaluationPayload = z.infer<typeof policyEvaluationPayloadSchema>;

export const contextAddedPayloadSchema = z.looseObject({
  key: z.string().max(256),
  value: jsonValueSchema,
});
export const contextRemovedPayloadSchema = z.looseObject({ key: z.string().max(256) });

export const approvalRequestedPayloadSchema = z.looseObject({
  approvalId: z.string().max(128),
  reason: z.string().max(2000),
  request: jsonValueSchema.optional(),
});
export const approvalResolvedPayloadSchema = z.looseObject({
  approvalId: z.string().max(128),
  decision: z.enum(["approved", "rejected", "pending"]),
  resolvedBy: z.string().max(128).optional(),
});

/** Outcome declared by the program at `trace.completed` / `trace.failed`. */
export const outcomeSchema = z.looseObject({
  kind: z.string().max(64),
  label: z.string().max(256),
  summary: z.string().max(4000).optional(),
});
export type Outcome = z.infer<typeof outcomeSchema>;

export const traceEndPayloadSchema = z.looseObject({
  outcome: outcomeSchema.optional(),
  error: z.looseObject({ message: z.string(), code: z.string().optional() }).optional(),
});

/** Event types that open a span. */
export const SPAN_OPENERS: Record<string, string> = {
  "tool.request": "tool",
  "model.request": "model",
  "agent.started": "agent",
};
