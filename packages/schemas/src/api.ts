import { z } from "zod";
import { comparisonSchema } from "./comparison.js";
import {
  agentSchema,
  artifactSchema,
  branchSchema,
  forkSchema,
  projectSchema,
  replayModeSchema,
  replaySchema,
  traceSchema,
  traceStatusSchema,
} from "./entities.js";
import { eventSchema, ingestEventSchema } from "./events.js";
import { idSchema } from "./ids.js";
import { jsonObjectSchema, jsonValueSchema } from "./json.js";
import { overrideSchema } from "./overrides.js";
import { SCHEMA_VERSION, schemaVersionSchema } from "./version.js";

/** Consistent error envelope returned by every API error. */
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
    requestId: z.string().optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export const cursorPageQuerySchema = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});

export function pageSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() });
}

export const createProjectBodySchema = projectSchema
  .pick({ slug: true, name: true })
  .extend({ description: z.string().max(2000).optional(), metadata: jsonObjectSchema.optional() });

export const createTraceBodySchema = z.object({
  id: idSchema.optional(),
  project: z.string().min(1).max(64).describe("Project slug; created on first use."),
  agent: z.string().min(1).max(64).describe("Agent slug; created on first use."),
  name: z.string().min(1).max(256),
  startedAt: z.iso.datetime({ offset: true }).optional(),
  tags: z.array(z.string().max(64)).max(64).optional(),
  metadata: jsonObjectSchema.optional(),
});
export type CreateTraceBody = z.infer<typeof createTraceBodySchema>;

export const traceListQuerySchema = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  project: z.string().max(64).optional(),
  agent: z.string().max(64).optional(),
  status: traceStatusSchema.optional(),
  tag: z.string().max(64).optional(),
  tool: z.string().max(128).optional(),
  q: z.string().max(256).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  minCost: z.coerce.number().nonnegative().optional(),
  minDurationMs: z.coerce.number().nonnegative().optional(),
  sort: z
    .enum(["startedAt", "durationMs", "totalEstimatedCost", "totalTokens", "name"])
    .default("startedAt"),
  order: z.enum(["asc", "desc"]).default("desc"),
});
export type TraceListQuery = z.infer<typeof traceListQuerySchema>;

export const ingestEventsBodySchema = z.object({
  branchId: idSchema.optional(),
  events: z.array(ingestEventSchema).min(1).max(5000),
});
export type IngestEventsBody = z.infer<typeof ingestEventsBodySchema>;
export type IngestEventsBodyInput = z.input<typeof ingestEventsBodySchema>;

export const eventListQuerySchema = cursorPageQuerySchema.extend({
  branchId: idSchema.optional(),
  eventType: z.string().max(96).optional(),
  /** Exact event name (tool, model, policy or step name). */
  name: z.string().max(256).optional(),
  severity: z.enum(["debug", "info", "warn", "error"]).optional(),
  /** Case-insensitive substring of the event name or type. */
  q: z.string().max(256).optional(),
  /** Include events inherited from parent branches (default true). */
  inherited: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .transform((v) => v === true || v === "true")
    .default(true),
});

export const createForkBodySchema = z.object({
  /** Event after which the new branch diverges. */
  forkEventId: idSchema,
  parentBranchId: idSchema.optional(),
  name: z.string().min(1).max(128).optional(),
  overrides: z.array(overrideSchema).max(200).default([]),
  metadata: jsonObjectSchema.optional(),
});
export type CreateForkBody = z.infer<typeof createForkBodySchema>;
export type CreateForkBodyInput = z.input<typeof createForkBodySchema>;

/**
 * Partial update of a trace's editable fields. `tags` replaces the whole list;
 * `addTags`/`removeTags` adjust it. `metadata` is merged key-by-key (set a key to
 * `null` to delete it).
 */
export const updateTraceBodySchema = z
  .object({
    name: z.string().min(1).max(256).optional(),
    tags: z.array(z.string().min(1).max(64)).max(64).optional(),
    addTags: z.array(z.string().min(1).max(64)).max(64).optional(),
    removeTags: z.array(z.string().min(1).max(64)).max(64).optional(),
    metadata: z.record(z.string(), jsonValueSchema.nullable()).optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: "provide at least one field to update",
  });
export type UpdateTraceBody = z.infer<typeof updateTraceBodySchema>;

/**
 * Bulk deletion for retention: every trace that started before `before` and
 * matches the optional filters. `dryRun` reports what would be deleted.
 */
export const pruneTracesBodySchema = z.object({
  before: z.iso.datetime({ offset: true }),
  project: z.string().max(64).optional(),
  agent: z.string().max(64).optional(),
  status: traceStatusSchema.optional(),
  tag: z.string().max(64).optional(),
  dryRun: z.boolean().default(false),
  limit: z.number().int().min(1).max(10_000).default(1000),
});
export type PruneTracesBody = z.infer<typeof pruneTracesBodySchema>;

export const updateBranchBodySchema = z.object({
  name: z.string().min(1).max(128).optional(),
  metadata: jsonObjectSchema.optional(),
});

export const replayRequestBodySchema = z.object({
  mode: replayModeSchema.default("deterministic"),
});

export const branchStateQuerySchema = z.object({
  /** Reconstruct state as of this event (inclusive). Defaults to the latest. */
  eventId: idSchema.optional(),
  sequence: z.coerce.number().int().min(-1).optional(),
});

export const createArtifactBodySchema = z.object({
  branchId: idSchema.optional(),
  eventId: idSchema.optional(),
  kind: z.string().min(1).max(64),
  name: z.string().min(1).max(256),
  contentType: z.string().min(1).max(128).default("application/json"),
  content: jsonValueSchema,
});
export type CreateArtifactBody = z.infer<typeof createArtifactBodySchema>;
export type CreateArtifactBodyInput = z.input<typeof createArtifactBodySchema>;

export const artifactListQuerySchema = z.object({
  branchId: idSchema.optional(),
  eventId: idSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const createComparisonBodySchema = z.object({
  baseBranchId: idSchema,
  targetBranchId: idSchema,
});

export const comparisonListQuerySchema = cursorPageQuerySchema.extend({
  traceId: idSchema.optional(),
  branchId: idSchema.optional(),
});

/** Portable, self-contained export of a trace and all its branches. */
export const traceExportSchema = z.object({
  format: z.literal("shadow.trace"),
  schemaVersion: schemaVersionSchema.default(SCHEMA_VERSION),
  exportedAt: z.iso.datetime({ offset: true }),
  project: projectSchema.pick({ slug: true, name: true, description: true, metadata: true }),
  agent: agentSchema.pick({ slug: true, name: true, description: true, metadata: true }),
  trace: traceSchema,
  branches: z.array(branchSchema),
  forks: z.array(forkSchema),
  replays: z.array(replaySchema),
  events: z.array(eventSchema).max(500_000),
  comparisons: z.array(comparisonSchema).default([]),
  artifacts: z.array(artifactSchema).default([]),
});
export type TraceExport = z.infer<typeof traceExportSchema>;
export type TraceExportInput = z.input<typeof traceExportSchema>;

export const importTraceBodySchema = z.object({
  bundle: traceExportSchema,
  /** `keep` fails on id collisions; `regenerate` assigns fresh ids. */
  idStrategy: z.enum(["keep", "regenerate"]).default("keep"),
});
