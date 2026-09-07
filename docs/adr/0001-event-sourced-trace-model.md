# 0001. Event-sourced trace model

- **Status:** Accepted
- **Date:** 2026-09-03
- **Deciders:** Shadow maintainers

## Context

Shadow's purpose is time-travel debugging for AI agents: inspect what an agent knew at any point
of an execution, fork the execution at that point with changed inputs, re-run it, and compare the
result with the original. Three requirements drive the data model:

1. **Any point in time must be reconstructable.** A debugger that can only show the final state
   is a log viewer. We need the state and context of the agent _as of_ any event.
2. **Branches must share history.** A fork that copies the whole prefix would duplicate data for
   every counterfactual and make "what is shared" a question of diffing payloads rather than a
   structural fact.
3. **Recorded and replayed executions must be comparable.** The comparison engine needs a
   representation where "the same step" is identifiable across branches and where differences
   can be located precisely.

Agent frameworks differ widely in their execution models (linear tool loops, graphs, multi-agent
handoffs). The model also has to accept events from integrations that Shadow does not know about
without breaking existing readers.

## Decision

We will model a trace as an **append-only log of immutable events** and derive every other view
(execution tree, state, metrics, outcome, comparison) from that log.

- Each event carries `traceId`, `branchId`, a monotonically increasing `sequence` within its
  branch, a `timestamp`, an open `eventType` string of the form `category.action`, a `name`, and
  optional `input`/`output` JSON payloads. Span structure is expressed with `spanId`,
  `parentSpanId` and `parentEventId`; there is no separate span table.
- **Branches inherit their prefix.** A child branch stores only the events after its fork point
  and records `forkSequence`; the effective timeline of a branch is the parent's effective events
  with `sequence <= forkSequence` followed by the branch's own events. Shared history is therefore
  a structural property, and "shared prefix" in comparisons is the run of identical event ids.
- **State is event-sourced too.** `state.patch` (RFC 6902 subset), `context.added`,
  `context.removed` and `state.snapshot` events are the only mutations. Reconstruction replays
  them from the nearest snapshot; snapshots are an optimisation, never the source of truth.
- **Every event carries `schemaVersion`** (`MAJOR.MINOR`). Readers ignore unknown fields and
  unknown event types; the store preserves unknown top-level fields in an `extra` column. Minor
  versions are additive; major versions require a migration.
- Replay and override activity is recorded as ordinary events (`fork.created`, `replay.*`, and
  override mutations with `metadata.shadow.origin = "override"`), so a branch is self-describing.

## Consequences

Positive:

- Reconstruction at any boundary, forks, replay verification and comparison all fall out of one
  representation. The history cursor used by deterministic replay is simply a cursor over the
  same log.
- Export/import is a serialisation of the log plus entity rows; no derived data needs to travel.
- Integrations can emit their own event types (`langgraph.node_entered`) without a schema change.
- Storage is simple to reason about and index: `(branch_id, sequence)` is unique and sufficient
  for ordering.

Negative:

- Reads that need state must replay events; without snapshots this is O(n) in the trace length.
  We mitigate with automatic snapshots every 25 mutations and a `state_snapshots` table (see
  [ADR 0004](./0004-postgres-initial-storage.md)).
- Derived aggregates (branch metrics, outcome, search text) must be recomputed on ingestion and
  after replay, and can drift if a code path forgets to. The API centralises this in
  `recomputeBranchMetrics`.
- Deleting or editing an event is not supported by design. Correcting a trace means deleting the
  whole trace or importing a corrected bundle.
- Consumers must understand span conventions (openers, closers, `parentEventId`) to build a tree;
  the API offers `/traces/:id/tree` so clients do not each reimplement it.

Neutral:

- Payload shapes for known types are deliberately lenient (`looseObject`), which trades strict
  validation for forward compatibility.

## Alternatives considered

- **Mutable trace document (one JSON per run).** Simple to store and render, but there is no way
  to reconstruct intermediate state, forks would copy the document, and concurrent appends during
  a long run would need locking. Rejected.
- **Span-tree model (OpenTelemetry style) as the primary representation.** Spans capture timing
  and hierarchy well but not the ordered sequence of state mutations, and they encourage
  in-place updates (a span is "ended"). We keep spans as attributes on events and can map to and
  from OTLP (see `docs/integrations/opentelemetry.md`). Rejected as the primary model.
- **Full copies per branch.** Straightforward, but every counterfactual multiplies storage by the
  prefix length and the shared prefix becomes a payload comparison rather than an identity.
  Rejected.
- **Storing only snapshots, not patches.** Cheaper reads, but per-mutation snapshots are large and
  lose the information of _what_ changed at each step. Rejected; snapshots are kept as an
  optimisation over patches.
