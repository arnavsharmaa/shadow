import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "string" });

export const projects = pgTable("projects", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const agents = pgTable(
  "agents",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    replayable: boolean("replayable").notNull().default(false),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("agents_project_slug_idx").on(t.projectId, t.slug)],
);

export const traces = pgTable(
  "traces",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    rootBranchId: text("root_branch_id").notNull(),
    name: text("name").notNull(),
    status: text("status").notNull().default("running"),
    schemaVersion: text("schema_version").notNull(),
    startedAt: ts("started_at").notNull(),
    completedAt: ts("completed_at"),
    durationMs: real("duration_ms"),
    outcome: jsonb("outcome"),
    tags: jsonb("tags").notNull().default([]),
    metadata: jsonb("metadata").notNull().default({}),
    metrics: jsonb("metrics").notNull().default({}),
    branchCount: integer("branch_count").notNull().default(1),
    /** Lower-cased searchable text (ids, names, tags, tools, metadata values). */
    searchText: text("search_text").notNull().default(""),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("traces_project_idx").on(t.projectId),
    index("traces_agent_idx").on(t.agentId),
    index("traces_status_idx").on(t.status),
    index("traces_started_at_idx").on(t.startedAt),
    index("traces_tags_idx").using("gin", t.tags),
  ],
);

export const branches = pgTable(
  "branches",
  {
    id: text("id").primaryKey(),
    traceId: text("trace_id")
      .notNull()
      .references(() => traces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    parentBranchId: text("parent_branch_id"),
    forkId: text("fork_id"),
    forkEventId: text("fork_event_id"),
    forkSequence: integer("fork_sequence"),
    depth: integer("depth").notNull().default(0),
    status: text("status").notNull().default("recording"),
    outcome: jsonb("outcome"),
    metrics: jsonb("metrics").notNull().default({}),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("branches_trace_idx").on(t.traceId),
    index("branches_parent_idx").on(t.parentBranchId),
  ],
);

export const events = pgTable(
  "events",
  {
    id: text("id").primaryKey(),
    schemaVersion: text("schema_version").notNull(),
    traceId: text("trace_id")
      .notNull()
      .references(() => traces.id, { onDelete: "cascade" }),
    branchId: text("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "cascade" }),
    parentEventId: text("parent_event_id"),
    spanId: text("span_id"),
    parentSpanId: text("parent_span_id"),
    sequence: integer("sequence").notNull(),
    timestamp: ts("timestamp").notNull(),
    durationMs: real("duration_ms"),
    eventType: text("event_type").notNull(),
    source: text("source").notNull().default("sdk"),
    severity: text("severity").notNull().default("info"),
    name: text("name").notNull(),
    input: jsonb("input"),
    output: jsonb("output"),
    metadata: jsonb("metadata").notNull().default({}),
    tags: jsonb("tags").notNull().default([]),
    tokenUsage: jsonb("token_usage"),
    estimatedCost: jsonb("estimated_cost"),
    stateVersion: integer("state_version"),
    correlationId: text("correlation_id"),
    /** Unknown top-level fields preserved for forward compatibility. */
    extra: jsonb("extra"),
  },
  (t) => [
    uniqueIndex("events_branch_sequence_idx").on(t.branchId, t.sequence),
    index("events_trace_sequence_idx").on(t.traceId, t.sequence),
    index("events_timestamp_idx").on(t.timestamp),
    index("events_type_idx").on(t.eventType),
    index("events_name_idx").on(t.name),
    index("events_parent_idx").on(t.parentEventId),
  ],
);

export const stateSnapshots = pgTable(
  "state_snapshots",
  {
    id: text("id").primaryKey(),
    traceId: text("trace_id")
      .notNull()
      .references(() => traces.id, { onDelete: "cascade" }),
    branchId: text("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "cascade" }),
    eventId: text("event_id").notNull(),
    sequence: integer("sequence").notNull(),
    stateVersion: integer("state_version"),
    state: jsonb("state").notNull(),
    context: jsonb("context").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("state_snapshots_branch_sequence_idx").on(t.branchId, t.sequence)],
);

export const forks = pgTable(
  "forks",
  {
    id: text("id").primaryKey(),
    traceId: text("trace_id")
      .notNull()
      .references(() => traces.id, { onDelete: "cascade" }),
    parentBranchId: text("parent_branch_id").notNull(),
    childBranchId: text("child_branch_id").notNull(),
    forkEventId: text("fork_event_id").notNull(),
    forkSequence: integer("fork_sequence").notNull(),
    overrides: jsonb("overrides").notNull().default([]),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("forks_trace_idx").on(t.traceId), index("forks_child_idx").on(t.childBranchId)],
);

export const replays = pgTable(
  "replays",
  {
    id: text("id").primaryKey(),
    traceId: text("trace_id")
      .notNull()
      .references(() => traces.id, { onDelete: "cascade" }),
    branchId: text("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "cascade" }),
    forkId: text("fork_id"),
    mode: text("mode").notNull(),
    status: text("status").notNull(),
    startedAt: ts("started_at").notNull(),
    completedAt: ts("completed_at"),
    eventCount: integer("event_count").notNull().default(0),
    error: text("error"),
    metadata: jsonb("metadata").notNull().default({}),
  },
  (t) => [index("replays_branch_idx").on(t.branchId)],
);

export const comparisons = pgTable(
  "comparisons",
  {
    id: text("id").primaryKey(),
    traceId: text("trace_id")
      .notNull()
      .references(() => traces.id, { onDelete: "cascade" }),
    baseBranchId: text("base_branch_id").notNull(),
    targetBranchId: text("target_branch_id").notNull(),
    result: jsonb("result").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("comparisons_trace_idx").on(t.traceId),
    index("comparisons_branches_idx").on(t.baseBranchId, t.targetBranchId),
  ],
);

export const artifacts = pgTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    traceId: text("trace_id")
      .notNull()
      .references(() => traces.id, { onDelete: "cascade" }),
    branchId: text("branch_id").notNull(),
    eventId: text("event_id"),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    contentType: text("content_type").notNull(),
    content: jsonb("content").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("artifacts_trace_idx").on(t.traceId)],
);

export const schema = {
  projects,
  agents,
  traces,
  branches,
  events,
  stateSnapshots,
  forks,
  replays,
  comparisons,
  artifacts,
};

export const nowSql = sql`now()`;
