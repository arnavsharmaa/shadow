# Storage

Shadow persists traces in PostgreSQL through [Drizzle ORM](https://orm.drizzle.team). The same
schema and migrations run on embedded [PGlite](https://pglite.dev) (the default for local
development and tests) and on a real PostgreSQL server. The reasoning is recorded in
[ADR 0004](../adr/0004-postgres-initial-storage.md).

## Choosing a database

| `DATABASE_URL`                      | Driver | Notes                                                                  |
| ----------------------------------- | ------ | ---------------------------------------------------------------------- |
| unset / empty                       | PGlite | Data in `SHADOW_DATA_DIR` (default `.shadow/data` under the repo root) |
| `pglite://<directory>`              | PGlite | Explicit data directory                                                |
| `memory://` or `pglite://memory`    | PGlite | In-memory; used by integration tests                                   |
| `postgres://user:pass@host:5432/db` | `pg`   | Connection pool (max 10). `postgresql://` also accepted                |

`docker compose up` starts a PostgreSQL container; point `DATABASE_URL` at it
(`postgres://shadow:shadow@localhost:5432/shadow`) as shown in `.env.example`. CI runs the
integration suite against both PGlite and a PostgreSQL service container.

Migrations live in `apps/api/drizzle` (`0000_init.sql` plus the drizzle-kit `meta` journal). They
are applied by `pnpm db:migrate` or automatically at API startup when `SHADOW_AUTO_MIGRATE=true`.
`pnpm db:seed` (re)creates the demo traces; `pnpm db:reset` drops every Shadow table, re-applies
migrations and seeds. New migrations are generated with `pnpm db:generate` after editing
`apps/api/src/db/schema.ts`.

## Tables

All ids are opaque `text` primary keys with a type prefix (`prj_`, `agt_`, `trc_`, `br_`, `evt_`,
`spn_`, `frk_`, `rpl_`, `cmp_`, `art_`, `apr_`). Timestamps are `timestamp with time zone`.
Foreign keys cascade on delete, so deleting a trace removes its branches, events, snapshots,
forks, replays, comparisons and artifacts.

### `projects`

| Column                     | Type        | Notes                             |
| -------------------------- | ----------- | --------------------------------- |
| `id`                       | text PK     |                                   |
| `slug`                     | text unique | lowercase letters, digits, dashes |
| `name`                     | text        |                                   |
| `description`              | text null   |                                   |
| `metadata`                 | jsonb       | default `{}`                      |
| `created_at`, `updated_at` | timestamptz |                                   |

### `agents`

| Column                        | Type                | Notes                                                                           |
| ----------------------------- | ------------------- | ------------------------------------------------------------------------------- |
| `id`                          | text PK             |                                                                                 |
| `project_id`                  | text FK -> projects |                                                                                 |
| `slug`, `name`, `description` | text                |                                                                                 |
| `replayable`                  | boolean             | true when a program with this slug is in the `AgentRegistry` (refreshed on use) |
| `metadata`                    | jsonb               |                                                                                 |
| `created_at`                  | timestamptz         |                                                                                 |

Unique index `agents_project_slug_idx (project_id, slug)`.

### `traces`

One execution. Created by `POST /traces`, by the seed or by import.

| Column                       | Type        | Notes                                                   |
| ---------------------------- | ----------- | ------------------------------------------------------- |
| `id`                         | text PK     |                                                         |
| `project_id`                 | text FK     |                                                         |
| `agent_id`                   | text FK     |                                                         |
| `root_branch_id`             | text        | the `main` branch                                       |
| `name`                       | text        |                                                         |
| `status`                     | text        | `running`, `completed`, `failed`                        |
| `schema_version`             | text        | schema version at creation                              |
| `started_at`, `completed_at` | timestamptz |                                                         |
| `duration_ms`                | real null   |                                                         |
| `outcome`                    | jsonb null  | `{kind, label, summary?}` from the trace end event      |
| `tags`                       | jsonb       | array of strings                                        |
| `metadata`                   | jsonb       |                                                         |
| `metrics`                    | jsonb       | root-branch `BranchMetrics`                             |
| `branch_count`               | integer     |                                                         |
| `search_text`                | text        | lower-cased bag of words used by `q` and `tool` filters |
| `created_at`, `updated_at`   | timestamptz |                                                         |

Indexes: `traces_project_idx (project_id)`, `traces_agent_idx (agent_id)`,
`traces_status_idx (status)`, `traces_started_at_idx (started_at)`, GIN `traces_tags_idx (tags)`.

### `branches`

Lineage node. The root branch has `parent_branch_id = null`; child branches record where they
diverge.

| Column                     | Type         | Notes                                                      |
| -------------------------- | ------------ | ---------------------------------------------------------- |
| `id`                       | text PK      |                                                            |
| `trace_id`                 | text FK      |                                                            |
| `name`                     | text         | `main` for the root; `fork-N` default for children         |
| `parent_branch_id`         | text null    |                                                            |
| `fork_id`                  | text null    |                                                            |
| `fork_event_id`            | text null    | first event re-executed on this branch                     |
| `fork_sequence`            | integer null | last sequence inherited from the parent lineage            |
| `depth`                    | integer      | root = 0                                                   |
| `status`                   | text         | `recording`, `pending`, `replaying`, `completed`, `failed` |
| `outcome`                  | jsonb null   |                                                            |
| `metrics`                  | jsonb        | `BranchMetrics` over the effective lineage                 |
| `metadata`                 | jsonb        |                                                            |
| `created_at`, `updated_at` | timestamptz  |                                                            |

Indexes: `branches_trace_idx (trace_id)`, `branches_parent_idx (parent_branch_id)`.

### `events`

The append-only log. A child branch stores only events with `sequence > fork_sequence`; the
effective lineage is computed at read time (see below).

| Column                      | Type         | Notes                                               |
| --------------------------- | ------------ | --------------------------------------------------- |
| `id`                        | text PK      |                                                     |
| `schema_version`            | text         |                                                     |
| `trace_id`                  | text FK      |                                                     |
| `branch_id`                 | text FK      |                                                     |
| `parent_event_id`           | text null    | closer -> opener, outcome -> evaluation             |
| `span_id`, `parent_span_id` | text null    |                                                     |
| `sequence`                  | integer      | strictly increasing per branch                      |
| `timestamp`                 | timestamptz  |                                                     |
| `duration_ms`               | real null    | set on closing events                               |
| `event_type`                | text         | `category.action`                                   |
| `source`                    | text         | `sdk`, `api`, `replay`, `import`, `seed`, or custom |
| `severity`                  | text         | `debug`, `info`, `warn`, `error`                    |
| `name`                      | text         |                                                     |
| `input`, `output`           | jsonb null   |                                                     |
| `metadata`                  | jsonb        | includes the reserved `shadow` namespace            |
| `tags`                      | jsonb        | array of strings                                    |
| `token_usage`               | jsonb null   |                                                     |
| `estimated_cost`            | jsonb null   |                                                     |
| `state_version`             | integer null |                                                     |
| `correlation_id`            | text null    |                                                     |
| `extra`                     | jsonb null   | unknown top-level fields, preserved verbatim        |

Indexes: unique `events_branch_sequence_idx (branch_id, sequence)`,
`events_trace_sequence_idx (trace_id, sequence)`, `events_timestamp_idx (timestamp)`,
`events_type_idx (event_type)`, `events_name_idx (name)`, `events_parent_idx (parent_event_id)`.

Ingestion inserts in chunks of 500 rows inside one transaction; a unique-index violation on
`(branch_id, sequence)` or on `id` is reported as `409 conflict`.

### `state_snapshots`

Materialised copies of `state.snapshot` events, written on ingestion, replay and import
(`insertSnapshots`), so reconstruction can find the nearest snapshot with one indexed query.

| Column                  | Type         | Notes                      |
| ----------------------- | ------------ | -------------------------- |
| `id`                    | text PK      | `snp_<eventId>`            |
| `trace_id`, `branch_id` | text FK      |                            |
| `event_id`              | text         | the `state.snapshot` event |
| `sequence`              | integer      |                            |
| `state_version`         | integer null |                            |
| `state`, `context`      | jsonb        |                            |
| `created_at`            | timestamptz  | the event timestamp        |

Index: `state_snapshots_branch_sequence_idx (branch_id, sequence)`. Inserts use
`ON CONFLICT DO NOTHING`, so re-ingesting a snapshot event is harmless. A branch's snapshots are
deleted before it is replayed again.

### `forks`

| Column                                | Type        | Notes                                  |
| ------------------------------------- | ----------- | -------------------------------------- |
| `id`                                  | text PK     |                                        |
| `trace_id`                            | text FK     |                                        |
| `parent_branch_id`, `child_branch_id` | text        |                                        |
| `fork_event_id`                       | text        | first re-executed event                |
| `fork_sequence`                       | integer     | last inherited sequence                |
| `overrides`                           | jsonb       | array of typed overrides (`ovr_N` ids) |
| `metadata`                            | jsonb       | includes `selectedEventId`             |
| `created_at`                          | timestamptz |                                        |

Indexes: `forks_trace_idx (trace_id)`, `forks_child_idx (child_branch_id)`.

### `replays`

| Column                       | Type        | Notes                                                 |
| ---------------------------- | ----------- | ----------------------------------------------------- |
| `id`                         | text PK     |                                                       |
| `trace_id`, `branch_id`      | text FK     |                                                       |
| `fork_id`                    | text null   |                                                       |
| `mode`                       | text        | `historical`, `deterministic`, `live`                 |
| `status`                     | text        | `pending`, `running`, `completed`, `failed`           |
| `started_at`, `completed_at` | timestamptz |                                                       |
| `event_count`                | integer     | events produced by the replay                         |
| `error`                      | text null   | replay error message (for example a history mismatch) |
| `metadata`                   | jsonb       | includes the agent slug                               |

Index: `replays_branch_idx (branch_id)`.

### `comparisons`

| Column                               | Type        | Notes                   |
| ------------------------------------ | ----------- | ----------------------- |
| `id`                                 | text PK     |                         |
| `trace_id`                           | text FK     |                         |
| `base_branch_id`, `target_branch_id` | text        |                         |
| `result`                             | jsonb       | full `ComparisonResult` |
| `created_at`                         | timestamptz |                         |

Indexes: `comparisons_trace_idx (trace_id)`,
`comparisons_branches_idx (base_branch_id, target_branch_id)`.

### `artifacts`

Reserved for files and large payloads attached to a trace, branch or event (`kind`, `name`,
`content_type`, `content` jsonb). The table and mapper exist in v0.1; there is no API surface
for it yet. Index: `artifacts_trace_idx (trace_id)`.

## Effective lineage

A branch's timeline is never copied. Given the root-to-leaf chain of branches, the API builds one
predicate:

```sql
(branch_id = root  AND sequence <= child1.fork_sequence)
OR (branch_id = child1 AND sequence <= child2.fork_sequence)
OR (branch_id = leaf)
```

ordered by `sequence`. Because a child's own events start at `fork_sequence + 1` (the
`fork.created` event) and every ancestor is cut at its child's `fork_sequence`, sequences are
unique and contiguous along the effective lineage. The same predicate shape is used for
`state_snapshots`. The `inherited=false` query flag on `GET /traces/:traceId/events` reads only
the branch's own rows.

## Snapshot strategy

- Producers emit `state.snapshot` events explicitly (`host.snapshot()`) and automatically every
  `SnapshotPolicy.everyMutations` state or context mutations (default 25; `snapshotEvery` in the
  SDK, `snapshotPolicy` on an `AgentDefinition`). Automatic snapshots are marked
  `metadata.auto = true`, have severity `debug`, and are not treated as program operations by
  replay.
- On write, snapshot payloads are mirrored into `state_snapshots`.
- On read (`GET /branches/:branchId/state`, `GET /traces/:traceId/events/:eventId/state`), the
  API selects the latest snapshot in the lineage with `sequence <= target`, then loads only the
  state-mutating events (`state.snapshot`, `state.patch`, `context.added`, `context.removed`)
  with `snapshot.sequence < sequence <= target`, and runs `reconstructState` over that short
  timeline. Cost is bounded by the snapshot interval rather than the trace length.
- Larger `everyMutations` values reduce write volume; smaller values speed up reconstruction.
  The synthetic load agent uses 200 for benchmarks.

## Derived data and consistency

The following columns are derived from events and recomputed by the API after every ingestion
batch, replay and import:

- `branches.metrics`, `branches.outcome`, `traces.metrics`, `traces.duration_ms`
  (`recomputeBranchMetrics`);
- `traces.status`, `traces.outcome`, `traces.completed_at`, `branches.status` from
  `trace.completed` / `trace.failed` events (`applyLifecycle`);
- `traces.branch_count`;
- `traces.search_text` (`updateSearchText`).

Replaying a branch again deletes its previous replay output (events with
`sequence > fork_sequence + 1`) and its snapshots before writing the new result, so a branch
never holds two replays.

## Export and import

`GET /traces/:traceId/export` serialises the trace, its branches, forks, replays, all events
(own rows per branch, not the effective lineages) and comparisons into a `shadow.trace` bundle.
`POST /traces/import` validates the bundle (`parseBundle`: schema version compatibility, branch
and event references, strictly increasing sequences per branch), optionally regenerates every id
while preserving references (`idStrategy: "regenerate"`), inserts all rows in one transaction,
mirrors snapshots and recomputes metrics per branch.

## Scaling path

Summarised from [ADR 0004](../adr/0004-postgres-initial-storage.md):

1. Partition `events` and `state_snapshots` by time and project; retention becomes a partition
   drop.
2. Retention policies and hot/cold tiers; cold traces archived as bundles in object storage.
3. Large payloads offloaded to object storage with references in the event row (`artifacts`).
4. Columnar analytics store for cross-trace metrics fed by an exporter.
5. Full-text or external search behind the `SearchProvider` interface.
6. Per-tenant sharding and encryption once authentication and organisations exist.

None of these steps changes the trace schema.
