# API reference

The Shadow API is a [Fastify 5](https://fastify.dev) service. Every request and response is
validated against Zod schemas from `@shadow/schemas` (via `fastify-type-provider-zod`), and an
OpenAPI 3.1 document is generated from them:

- Swagger UI: `http://localhost:4000/docs`
- Raw document: `http://localhost:4000/openapi.json`

This page is a human-readable summary; the OpenAPI document is authoritative for field-level
detail. Types referenced below (`Trace`, `Branch`, `ShadowEvent`, `Fork`, `Replay`,
`Comparison`, `ReconstructedState`, `TraceExport`, ...) are defined in `packages/schemas/src`.

## Conventions

- Base URL: `http://<SHADOW_API_HOST>:<SHADOW_API_PORT>` (default `http://127.0.0.1:4000`).
  Versioned routes are prefixed with `/api/v1`; `/health`, `/docs` and `/openapi.json` are not.
- Content type: `application/json` for request and response bodies.
- Ids are opaque strings (`^[A-Za-z0-9_.:-]+$`, max 128 chars). Shadow generates prefixed ids
  (`trc_…`, `br_…`, `evt_…`), but clients may supply their own where the schema allows.
- Timestamps are ISO 8601 with offset.
- Every response carries an `x-request-id` header. Clients may send their own `x-request-id`;
  otherwise one is generated (`req_…`). Request ids appear in structured logs and error bodies.
- There is no authentication in v0.1 (see [SECURITY.md](../../SECURITY.md)).
- CORS is enabled for the origins in `SHADOW_CORS_ORIGINS` (default the local web app).
- Request bodies are limited to `SHADOW_MAX_BODY_BYTES` (default 10 MiB).

### Pagination

Two paginated shapes exist:

- **Sequence cursors** (events): `{ items: T[], nextCursor: string | null }`. Pass `nextCursor`
  back as `cursor`. The cursor encodes the last returned `sequence`; `limit` is 1–1000, default 200.
- **Trace listing**: `{ items: TraceSummary[], nextCursor: string | null, total: number }`.
  The cursor encodes an offset; `limit` is 1–200, default 50.

`GET /comparisons` returns the page shape but always `nextCursor: null` (bounded by `limit`).

### Errors

All errors use one envelope:

```json
{
  "error": {
    "code": "not_found",
    "message": "trace trc_123 was not found",
    "details": { "resource": "trace", "id": "trc_123" },
    "requestId": "req_5f0c…"
  }
}
```

| Status | `code`                                           | When                                                                                                                       |
| ------ | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| 400    | `validation_error`                               | Body, query or params failed schema validation (`details` lists issues)                                                    |
| 400    | `bad_request`                                    | Semantically invalid input (invalid cursor, bundle validation failure, invalid event, branch/trace mismatch)               |
| 404    | `not_found`                                      | Unknown route or entity (`details.resource`, `details.id`)                                                                 |
| 409    | `conflict`                                       | Duplicate project slug, trace id, branch name, event id or sequence; import of an existing trace with `idStrategy: "keep"` |
| 413    | `payload_too_large`                              | Body exceeds `SHADOW_MAX_BODY_BYTES`                                                                                       |
| 415    | `unsupported_media_type`                         | Missing or non-JSON content type, empty JSON body                                                                          |
| 422    | `not_forkable`                                   | Fork point is a replay bookkeeping event                                                                                   |
| 422    | `not_forked`                                     | Replay requested on a root branch                                                                                          |
| 422    | `unsupported_mode`                               | `mode: "historical"` sent to the replay endpoint                                                                           |
| 422    | `agent_not_replayable`                           | No program registered for the trace's agent (`details.replayable` lists registered slugs)                                  |
| 422    | `invalid_plan`, `no_program`, `history_mismatch` | Replay plan could not be built                                                                                             |
| 422    | `root_branch`                                    | Attempt to delete the root branch                                                                                          |
| 422    | `different_traces`, `same_branch`                | Invalid comparison pair                                                                                                    |
| 500    | `internal_error`                                 | Unhandled error (logged with the request id)                                                                               |
| 500    | `serialization_error`                            | Response did not match its schema                                                                                          |
| 501    | `live_replay_disabled`                           | `mode: "live"` is not enabled in this release                                                                              |

## Health

### `GET /health`

Returns `200` when the database answers, `503` otherwise.

```json
{
  "status": "ok",
  "version": "0.1.0",
  "uptimeSeconds": 42,
  "database": { "kind": "pglite", "location": "pglite:/…/.shadow/data", "healthy": true }
}
```

## Projects and agents

### `GET /api/v1/projects`

`{ items: Project[] }`, ordered by name.

### `POST /api/v1/projects`

Body: `{ slug, name, description?, metadata? }` (`slug` must match `^[a-z0-9][a-z0-9-]*$`).
Returns `201 Project`; `409` if the slug exists. Projects are also created implicitly by
`POST /traces` and by import.

### `GET /api/v1/agents?projectId=`

```json
{
  "items": [Agent],
  "replayable": [{ "slug": "refund-agent", "name": "Refund Agent", "description": "…" }]
}
```

`replayable` lists programs registered in the API's `AgentRegistry`; `Agent.replayable` is true
when the agent slug matches one of them.

## Traces

### `GET /api/v1/traces`

Query parameters:

| Name            | Type                                                                           | Notes                                            |
| --------------- | ------------------------------------------------------------------------------ | ------------------------------------------------ |
| `cursor`        | string                                                                         | from a previous `nextCursor`                     |
| `limit`         | 1–200 (default 50)                                                             |                                                  |
| `project`       | project slug                                                                   |                                                  |
| `agent`         | agent slug                                                                     |                                                  |
| `status`        | `running` \| `completed` \| `failed`                                           |                                                  |
| `tag`           | string                                                                         | exact tag match                                  |
| `tool`          | string                                                                         | traces that called this tool                     |
| `q`             | string                                                                         | free text over ids, names, tags, metadata, tools |
| `from`, `to`    | ISO timestamp                                                                  | `startedAt` range                                |
| `minCost`       | number                                                                         | `metrics.totalEstimatedCost >=`                  |
| `minDurationMs` | number                                                                         |                                                  |
| `sort`          | `startedAt` \| `durationMs` \| `totalEstimatedCost` \| `totalTokens` \| `name` | default `startedAt`                              |
| `order`         | `asc` \| `desc`                                                                | default `desc`                                   |

Response: `{ items: TraceSummary[], nextCursor, total }`. `TraceSummary` is a `Trace` plus
`projectSlug`, `projectName`, `agentSlug`, `agentName`.

### `GET /api/v1/traces/facets`

Distinct filter values for the explorer:
`{ projects: [{slug,name}], agents: [{slug,name,projectSlug}], tags: string[], tools: string[] }`.

### `POST /api/v1/traces`

Body:

```json
{
  "id": "trc_optional",
  "project": "support-agent",
  "agent": "refund-agent",
  "name": "refund-request: defective headphones",
  "startedAt": "2026-09-01T09:12:04.000Z",
  "tags": ["refund"],
  "metadata": { "ticketId": "TCK-20931" }
}
```

Project and agent are slugs and are created on first use. Returns `201 Trace` with
`rootBranchId` (the `main` branch); `409` if `id` already exists.

### `POST /api/v1/traces/import`

Body: `{ bundle: TraceExport, idStrategy?: "keep" | "regenerate" }` (default `keep`). Validates
the bundle (schema version, references, sequence ordering) and inserts it. With `keep` a trace
with the same id yields `409`; with `regenerate` every id is replaced while references are
preserved. Returns `201 Trace`. Events inserted this way keep their original `source` and
metadata.

### `GET /api/v1/traces/:traceId`

`{ trace: TraceSummary, branches: Branch[] }`.

### `DELETE /api/v1/traces/:traceId`

`204`. Cascades to branches, events, snapshots, forks, replays, comparisons and artifacts.

## Events

### `GET /api/v1/traces/:traceId/events`

Query: `cursor`, `limit` (1–1000, default 200), `branchId` (default root), `eventType`,
`inherited` (default `true`; `false` returns only rows stored on the branch). Returns the
effective lineage of the branch ordered by sequence:

```json
{ "items": [ShadowEvent], "nextCursor": "eyJzIjo1OX0" }
```

### `POST /api/v1/traces/:traceId/events`

Body: `{ branchId?: string, events: IngestEvent[] }` with 1–5000 events. `IngestEvent` is a
`ShadowEvent` without `traceId` and with optional `id`, `branchId`, `sequence` and `timestamp`:
the server fills missing ids, assigns the next sequence per branch (explicit sequences are
honoured and must not collide) and stamps the current time. `input`, `output` and `metadata` are
redacted server-side. Returns:

```json
{ "accepted": 12, "branch": Branch, "eventIds": ["evt_…"] }
```

`201` on success; `409` on duplicate id or sequence; `400` if an event fails validation.
Ingesting a `trace.completed` / `trace.failed` event on the root branch closes the trace.

### `GET /api/v1/traces/:traceId/tree?branchId=`

Execution hierarchy for a branch (default root), flattened depth-first:

```json
{
  "branchId": "br_…",
  "events": [ShadowEvent],
  "nodes": [{ "id": "evt_…", "depth": 1, "childCount": 2, "spanDurationMs": 900 }]
}
```

`nodes[i]` describes `events` by id; children nest under `parentEventId`, or under the opener of
their span (see [Events](../concepts/events.md#spans-and-hierarchy)).

### `GET /api/v1/traces/:traceId/events/:eventId`

A single `ShadowEvent`.

### `GET /api/v1/traces/:traceId/events/:eventId/state?branchId=`

State and context before and after the event, as seen from a branch lineage (default: the
event's own branch):

```json
{
  "event": { "id": "evt_…", "sequence": 17 },
  "branchId": "br_…",
  "before": ReconstructedState,
  "after": ReconstructedState,
  "stateDiff": [{ "path": "/step", "op": "changed", "before": "decide", "after": "refund" }],
  "contextDiff": []
}
```

`ReconstructedState` is `{ state, context, stateVersion, asOfSequence, fromSnapshotSequence,
appliedEvents, branchId }`.

## Branches, forks and replays

### `GET /api/v1/traces/:traceId/branches`

`{ items: Branch[] }` ordered by creation.

### `GET /api/v1/traces/:traceId/forks`

`{ items: Fork[] }`.

### `POST /api/v1/traces/:traceId/forks`

Body:

```json
{
  "forkEventId": "evt_refund_request",
  "parentBranchId": "br_main",
  "name": "limit-100",
  "overrides": [
    { "kind": "context", "op": "set", "key": "refundLimit", "value": 100, "label": "Real limit" }
  ],
  "metadata": {}
}
```

`parentBranchId` defaults to the branch the event is stored on. The fork point is normalised to
an operation boundary (a response forks at its request; a policy outcome at its evaluation or
the guarded tool request). Up to 200 overrides; see
[Forks and overrides](../concepts/forks-and-overrides.md). Returns `201 { branch, fork }` where
`branch.status` is `pending`. Errors: `404` unknown event, `422 not_forkable`, `409` duplicate
branch name.

### `GET /api/v1/traces/:traceId/replays`

`{ items: Replay[] }`.

### `GET /api/v1/traces/:traceId/export`

The `shadow.trace` bundle for the trace, with a `content-disposition` attachment header
(`<traceId>.shadow.json`):

```json
{
  "format": "shadow.trace",
  "schemaVersion": "1.0",
  "exportedAt": "…",
  "project": { "slug", "name", "description", "metadata" },
  "agent": { "slug", "name", "description", "metadata" },
  "trace": Trace,
  "branches": [Branch],
  "forks": [Fork],
  "replays": [Replay],
  "events": [ShadowEvent],
  "comparisons": [Comparison]
}
```

### `GET /api/v1/branches/:branchId`

`Branch`.

### `PATCH /api/v1/branches/:branchId`

Body `{ name?, metadata? }`. Returns the updated `Branch`.

### `DELETE /api/v1/branches/:branchId`

Deletes a forked branch and all its descendants: `{ deleted: ["br_…"] }`. `422 root_branch` for
the root.

### `GET /api/v1/branches/:branchId/events`

Same as the trace-scoped events endpoint with `inherited=true`; query `cursor`, `limit`,
`eventType`.

### `GET /api/v1/branches/:branchId/state?eventId=&sequence=`

`ReconstructedState` at the given boundary (inclusive). Defaults to the latest event; `sequence`
may be `-1` for the empty state.

### `POST /api/v1/branches/:branchId/replay`

Body `{ mode?: "historical" | "deterministic" | "live" }` (default `deterministic`). Runs a
deterministic counterfactual replay of a forked branch synchronously and returns
`201 { replay: Replay, branch: Branch }`. Previous replay output on the branch is discarded first.

- `replay.status` is `completed` or `failed`; a history mismatch is reported as `failed` with
  `replay.error` set and a `replay.failed` event on the branch.
- `422 not_forked` for root branches; `422 unsupported_mode` for `historical` (read the events
  instead); `501 live_replay_disabled` for `live`; `422 agent_not_replayable` when no program is
  registered for the agent.

## Artifacts

Documents attached to a trace: an email that was sent, a retrieved page, a generated report.
Content is JSON (strings are fine for text) and is redacted like event payloads.

### `GET /api/v1/traces/:traceId/artifacts?branchId=&eventId=&limit=`

`{ items: Artifact[] }`, oldest first.

### `POST /api/v1/traces/:traceId/artifacts`

Body: `{ branchId?, eventId?, kind, name, contentType? = "application/json", content }`.
`branchId` defaults to the root branch; `eventId` must belong to the trace. Returns `201` with the
stored `Artifact`.

### `GET /api/v1/traces/:traceId/artifacts/:artifactId`

Returns one `Artifact` or `404`.

## Comparisons

### `GET /api/v1/comparisons?traceId=&branchId=&limit=`

`{ items: Comparison[], nextCursor: null }`, newest first. `branchId` matches either side.

### `POST /api/v1/comparisons`

Body `{ baseBranchId, targetBranchId }`; both branches must belong to the same trace and differ.
Computes and stores the comparison; returns `201 Comparison`:

```json
{
  "id": "cmp_…",
  "traceId": "trc_…",
  "baseBranchId": "br_main",
  "targetBranchId": "br_fork1",
  "createdAt": "…",
  "result": ComparisonResult
}
```

See [Branch comparison](../concepts/branch-comparison.md) for the `ComparisonResult` structure.

### `GET /api/v1/comparisons/:comparisonId`

`Comparison`.

## Configuration

| Variable                     | Default                                       | Purpose                                         |
| ---------------------------- | --------------------------------------------- | ----------------------------------------------- |
| `DATABASE_URL`               | unset (PGlite)                                | `postgres://…`, `pglite://<dir>` or `memory://` |
| `SHADOW_DATA_DIR`            | `.shadow/data`                                | PGlite directory when `DATABASE_URL` is unset   |
| `SHADOW_API_HOST`            | `127.0.0.1`                                   |                                                 |
| `SHADOW_API_PORT`            | `4000`                                        |                                                 |
| `SHADOW_LOG_LEVEL`           | `info`                                        | pino level                                      |
| `SHADOW_AUTO_MIGRATE`        | `true`                                        | apply migrations at startup                     |
| `SHADOW_AUTO_SEED`           | `true`                                        | seed demo data when the database is empty       |
| `SHADOW_MAX_BODY_BYTES`      | `10485760`                                    | request body limit                              |
| `SHADOW_REDACT_PATTERNS`     | empty                                         | comma-separated extra key regexes for redaction |
| `SHADOW_CORS_ORIGINS`        | `http://localhost:3000,http://127.0.0.1:3000` |                                                 |
| `NEXT_PUBLIC_SHADOW_API_URL` | `http://localhost:4000`                       | used by the web app                             |

Logs are structured JSON (pretty-printed on a TTY outside production) and redact
`authorization`, `cookie`, `password`, `apiKey`, `token`, `secret` and any key matching
`SHADOW_REDACT_PATTERNS`.
