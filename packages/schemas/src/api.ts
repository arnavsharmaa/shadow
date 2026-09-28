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
  BATCH_JOB_STATUSES,
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

/** Trace list parameters a saved view may carry (everything except paging). */
export const SAVED_VIEW_KEYS = [
  "project",
  "agent",
  "status",
  "tag",
  "tool",
  "q",
  "from",
  "to",
  "minCost",
  "minDurationMs",
  "sort",
  "order",
] as const;

const savedViewFiltersSchema = traceListQuerySchema
  .pick({
    project: true,
    agent: true,
    status: true,
    tag: true,
    tool: true,
    q: true,
    from: true,
    to: true,
    minCost: true,
    minDurationMs: true,
    sort: true,
    order: true,
  })
  .partial()
  .strict();

/**
 * Normalise a saved-view query string: drop paging, sort the keys and reject parameters or
 * values the trace list would not accept. Returns `null` when the query is invalid.
 */
export function normalizeViewQuery(query: string): string | null {
  const text = query.startsWith("?") ? query.slice(1) : query;
  const record: Record<string, string> = {};
  for (const pair of text.split("&")) {
    if (pair === "") continue;
    const index = pair.indexOf("=");
    const key = formDecode(index < 0 ? pair : pair.slice(0, index));
    const value = formDecode(index < 0 ? "" : pair.slice(index + 1));
    if (key === null || value === null) return null;
    if (key === "cursor" || key === "limit") continue;
    if (Object.hasOwn(record, key)) return null;
    record[key] = value;
  }
  if (!savedViewFiltersSchema.safeParse(record).success) return null;
  return Object.keys(record)
    .sort()
    .map((key) => `${formEncode(key)}=${formEncode(record[key] ?? "")}`)
    .join("&");
}

/** `application/x-www-form-urlencoded` decoding, as `URLSearchParams` does it. */
function formDecode(text: string): string | null {
  try {
    return decodeURIComponent(text.replace(/\+/g, " "));
  } catch {
    return null;
  }
}

/** `application/x-www-form-urlencoded` encoding, byte-for-byte what `URLSearchParams` emits. */
function formEncode(text: string): string {
  return encodeURIComponent(text)
    .replace(/%20/g, "+")
    .replace(/[!'()~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export const saveViewBodySchema = z.object({
  name: z.string().trim().min(1).max(64),
  query: z
    .string()
    .max(2048)
    .transform((value, ctx) => {
      const normalized = normalizeViewQuery(value);
      if (normalized === null) {
        ctx.addIssue({
          code: "custom",
          message: `query must only contain trace list filters (${SAVED_VIEW_KEYS.join(", ")}) with valid values`,
        });
        return z.NEVER;
      }
      return normalized;
    }),
  description: z.string().max(500).optional(),
});
export type SaveViewBody = z.infer<typeof saveViewBodySchema>;

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
  /** Traces carrying this tag are never deleted (retention uses `SHADOW_RETENTION_KEEP_TAG`). */
  excludeTag: z.string().max(64).optional(),
  dryRun: z.boolean().default(false),
  limit: z.number().int().min(1).max(10_000).default(1000),
});
export type PruneTracesBody = z.infer<typeof pruneTracesBodySchema>;

/**
 * Batch counterfactual: apply one override set to many recorded traces of an agent,
 * forking each at its first event matching `at`.
 */
export const MAX_SYNC_BATCH = 50;
export const MAX_BACKGROUND_BATCH = 500;

export const batchCounterfactualBodySchema = z
  .object({
    agent: z.string().min(1).max(64),
    project: z.string().max(64).optional(),
    at: z.object({
      eventType: z.string().min(1).max(96).default("tool.request"),
      name: z.string().min(1).max(256),
    }),
    overrides: z.array(overrideSchema).min(1).max(200),
    /** Branch name given to every fork (default: the next `fork-N` of each trace). */
    branchName: z.string().min(1).max(128).optional(),
    status: traceStatusSchema.optional(),
    tag: z.string().max(64).optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    /** Up to 50 traces synchronously, or up to 500 as a background job. */
    limit: z.number().int().min(1).max(MAX_BACKGROUND_BATCH).default(20),
    /** Queue the batch as a job and return `202` right away (see `GET /batch/jobs/:jobId`). */
    background: z.boolean().default(false),
  })
  .superRefine((body, ctx) => {
    if (!body.background && body.limit > MAX_SYNC_BATCH) {
      ctx.addIssue({
        code: "custom",
        path: ["limit"],
        message: `synchronous batches are limited to ${MAX_SYNC_BATCH} traces; set background: true for up to ${MAX_BACKGROUND_BATCH}`,
      });
    }
  });
export type BatchCounterfactualBody = z.infer<typeof batchCounterfactualBodySchema>;

export const auditListQuerySchema = cursorPageQuerySchema.extend({
  traceId: idSchema.optional(),
  action: z.string().max(64).optional(),
  actor: z.string().max(128).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type AuditListQuery = z.infer<typeof auditListQuerySchema>;

export const batchJobListQuerySchema = z.object({
  status: z.enum(BATCH_JOB_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** Scenario matrix: fork one event once per variant, replay and compare each. */
export const forkMatrixBodySchema = z.object({
  forkEventId: idSchema,
  parentBranchId: idSchema.optional(),
  variants: z
    .array(
      z.object({
        /** Branch name; defaults to the next `fork-N`. */
        name: z.string().min(1).max(128).optional(),
        overrides: z.array(overrideSchema).min(1).max(200),
      }),
    )
    .min(1)
    .max(20),
});
export type ForkMatrixBody = z.infer<typeof forkMatrixBodySchema>;

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
