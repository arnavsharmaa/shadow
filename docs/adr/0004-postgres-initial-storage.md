# 0004. PostgreSQL (and PGlite) as initial storage

- **Status:** Accepted
- **Date:** 2026-09-03
- **Deciders:** Shadow maintainers

## Context

Shadow stores an append-only event log per branch plus a handful of entity tables (projects,
agents, traces, branches, forks, replays, comparisons, state snapshots, artifacts). Access
patterns in v0.1 are:

- append batches of events to one branch (ingestion, replay output);
- read a branch's effective lineage ordered by sequence, often paginated;
- read the state-mutating events between a snapshot and a target sequence;
- list and filter traces by project, agent, status, tag, tool, free text, time and cost;
- store and read JSON documents (comparison results, overrides, metrics, payloads).

Two deployment shapes matter: a developer running `pnpm dev` on a laptop who should not have to
install a database, and a team deploying the API with a managed database. Long term, trace
volume from production agents can be large (millions of events per day) and analytical queries
across traces (cost trends, failure rates) will appear.

## Decision

We will use **PostgreSQL** as the storage engine, accessed through **Drizzle ORM**, and run the
**same schema on embedded PGlite** for local development and tests.

- `apps/api/src/db/schema.ts` defines the tables; migrations are generated with drizzle-kit into
  `apps/api/drizzle` and applied by `pnpm db:migrate` or automatically at API start
  (`SHADOW_AUTO_MIGRATE`).
- When `DATABASE_URL` is unset the API opens a PGlite database in `.shadow/data`
  (`SHADOW_DATA_DIR`); `pglite://<dir>` and `memory://` are also accepted. When `DATABASE_URL`
  starts with `postgres://` the API uses `pg` with a connection pool. The `DatabaseHandle`
  abstraction exposes `migrate`, `ping`, `reset` and `close` for both.
- Events are rows with typed columns for the fields the engine queries (`branch_id`,
  `sequence`, `timestamp`, `event_type`, `name`, `parent_event_id`, `span_id`, ...) and `jsonb`
  for payloads (`input`, `output`, `metadata`, `tags`, `token_usage`, `estimated_cost`) plus an
  `extra` column for unknown top-level fields.
- Indexes: unique `(branch_id, sequence)`, `(trace_id, sequence)`, `timestamp`, `event_type`,
  `name`, `parent_event_id`; trace indexes on project, agent, status, `started_at` and a GIN
  index on `tags`; `(branch_id, sequence)` on `state_snapshots`.
- Branch lineage is resolved in the API and expressed as an `OR` of
  `(branch_id = X AND sequence <= forkSequence)` predicates, so inherited events are read
  without copying.
- `state_snapshots` mirrors `state.snapshot` events so reconstruction can start from the nearest
  snapshot with one indexed query.
- Free-text search uses a lower-cased `search_text` column on `traces` with `ILIKE`, behind a
  `SearchProvider` interface.

## Consequences

Positive:

- Zero infrastructure for the demo and for tests: `pnpm dev` works on a fresh clone, and
  integration tests run against an in-memory database in CI and against a PostgreSQL service
  container for parity.
- One schema, one migration set, one query layer; PGlite _is_ PostgreSQL compiled to WebAssembly,
  so behaviour and SQL dialect match.
- `jsonb` gives flexible payload storage with indexing options (GIN) when needed, and
  transactions make ingestion batches and replay persistence atomic.
- Managed PostgreSQL is available everywhere teams deploy.

Negative:

- PGlite runs single-connection in-process; it is not suitable for concurrent multi-user use or
  large volumes. It is a development and test convenience, not a deployment target.
- Row-per-event storage in PostgreSQL will not scale indefinitely: hot tables grow without
  bound, large payloads bloat `jsonb`, and cross-trace analytics become expensive.
- `ILIKE` search on a bag-of-words column is adequate for a single developer's traces, not for
  a large shared store.
- Cursor pagination for trace listing currently uses an encoded offset; deep pages degrade.

Neutral:

- Drizzle's type-safe queries keep the service layer readable, at the cost of dropping to raw SQL
  for a few JSON operations (tag facets, cost sorting).

## Scaling path

The decision deliberately keeps the v0.1 schema simple. The planned evolution, in the order we
expect to need it:

1. **Partitioning.** Partition `events` (and `state_snapshots`) by time range and/or project so
   that retention is a partition drop and hot data stays small. PostgreSQL declarative
   partitioning requires the partition key in the primary key; we will add `trace_id`-based
   routing when this lands.
2. **Retention and hot/cold tiers.** Retention policies per project (v0.3) delete or archive
   old traces. Cold traces move to object storage as `shadow.trace` bundles (the export format
   already exists) and are re-imported on demand.
3. **Object storage for large payloads.** Model messages and tool results above a size threshold
   are stored as blobs (S3-compatible), with the event row holding a reference and a preview.
   The `artifacts` table is reserved for this and for user-attached files.
4. **Columnar analytics.** Cross-trace metrics (cost, latency, failure rates, policy decisions
   over time) move to a columnar store such as ClickHouse or a Parquet lake fed by an event
   exporter; PostgreSQL remains the transactional store for traces and replay.
5. **Search backend.** Replace the `ILIKE` provider with PostgreSQL full-text search or an
   external index behind the same `SearchProvider` interface.
6. **Multi-tenant sharding.** With authentication and organisations (v0.3, v1.0), shard by
   tenant: separate schemas or databases per tenant initially, with a routing layer in the API,
   and per-tenant encryption keys for payload columns.

Each step is additive to the event model; none changes the trace schema.

## Alternatives considered

- **SQLite (better-sqlite3 / libsql).** Excellent embedded story and simpler than PGlite, but the
  server deployment would then differ from the local one (two dialects, two migration sets, weaker
  JSON support, no GIN). Rejected in favour of PGlite, which keeps one dialect.
- **ClickHouse or another columnar store from the start.** Ideal for analytics and append-only
  logs, but poor at the point reads, updates to entity rows (branch status, metrics) and
  transactions that replay and ingestion need; also heavy to run locally. Deferred to the
  analytics tier.
- **Document database (MongoDB, DynamoDB).** Flexible payloads, but ordering guarantees, joins
  for lineage and transactional batch appends are weaker, and the embedded story is poor.
  Rejected.
- **Append-only log store (Kafka, Redpanda) as primary storage.** Natural for an event log but
  not queryable for state reconstruction or trace listing; would need a materialised store
  anyway. May appear as an ingestion buffer in the observability tier.
- **Files (JSONL per trace).** Simplest possible local storage and identical to the bundle
  format, but pagination, filtering and concurrent writes would all be reimplemented. Rejected;
  bundles remain the interchange format.
