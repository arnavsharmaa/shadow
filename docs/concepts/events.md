# Events

An event is the unit of the append-only log that Shadow stores, exchanges over the ingestion API
and exports in bundles. Everything else (execution tree, state, metrics, forks, replay,
comparison) is derived from events. The schema lives in `packages/schemas/src/events.ts`.

## Schema

```ts
{
  id: string;                     // "evt_…"; unique
  schemaVersion: string;          // "1.0" (MAJOR.MINOR)
  traceId: string;
  branchId: string;
  parentEventId: string | null;   // structural parent (closer -> opener, outcome -> evaluation)
  spanId: string | null;          // span this event belongs to / opens
  parentSpanId: string | null;    // enclosing span of a span opener
  sequence: number;               // strictly increasing within a branch, starts at 0
  timestamp: string;              // ISO 8601 with offset
  durationMs: number | null;      // set on closing events
  eventType: string;              // "category.action"
  source: string;                 // "sdk" | "api" | "replay" | "import" | "seed" | custom
  severity: "debug" | "info" | "warn" | "error";
  name: string;                   // tool name, model step, policy id, context key, JSON pointer…
  input?: JsonValue;
  output?: JsonValue;
  metadata: JsonObject;           // free-form; `metadata.shadow` is reserved
  tags: string[];
  tokenUsage: { inputTokens, outputTokens, totalTokens, cachedInputTokens? } | null;
  estimatedCost: { amount, currency, provider?, model?, pricingVersion? } | null;
  stateVersion: number | null;    // state store version after this event
  correlationId: string | null;   // free-form correlation key
  // …any unknown top-level field is preserved (stored in the `extra` column)
}
```

Notes:

- `eventType` must match `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$` (3–96 chars). The set below is
  what Shadow understands natively; integrations may add their own (`langgraph.node_entered`)
  and old readers will simply store and display them.
- Payloads (`input`, `output`) are plain JSON. Producers must serialise values themselves; the
  SDK and runtime do this with `toJson`, which drops `undefined` and rejects non-JSON values.
- `estimatedCost` is always an estimate derived from a pricing table (see
  [Cost tracking](./cost-tracking.md)).
- `sequence` is assigned by the producer (SDK, runtime) or by the API when omitted. Within a
  branch it is unique and strictly increasing; ordering ties are broken by `timestamp`, then `id`.

### Reserved metadata: `metadata.shadow`

Shadow writes its own bookkeeping under `metadata.shadow`:

| Field                        | Meaning                                                                                                                      |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `origin`                     | `recorded` (live run), `replay` (produced by a replay), `override` (mutation applied from a fork override), `import`, `seed` |
| `replayId`                   | replay that produced the event                                                                                               |
| `forkId`                     | fork the event belongs to (fork.created, override events)                                                                    |
| `correspondsTo`              | event in the parent lineage this replayed event corresponds to (reserved)                                                    |
| `overrideId`, `overrideKind` | override that produced or influenced this event                                                                              |
| `scenario`                   | agent definition slug (seeded and replayed traces)                                                                           |

Producers may use the rest of `metadata` freely. The runtime marks automatic snapshots with
`metadata.auto: true`.

## Spans and hierarchy

Shadow has no span table; hierarchy is encoded on events.

- **Span openers** (`SPAN_OPENERS`): `agent.started` opens the agent span, `tool.request` opens a
  tool span and `model.request` opens a model span. The opener carries the new `spanId` and the
  enclosing span as `parentSpanId`.
- **Closers** carry the same `spanId` as their opener and point at it with `parentEventId`:
  `tool.response` / `tool.error` -> `tool.request`; `model.response` -> `model.request`;
  `agent.completed` shares the agent span (no `parentEventId`).
- **Policy events**: `policy.allowed` / `policy.denied` / `policy.approval_required` point at
  their `policy.evaluated` with `parentEventId`. A guard evaluation performed inside a tool call
  points at the `tool.request`.
- **Approvals**: in the core runtime `human.approval_resolved` points at
  `human.approval_requested`.
- Everything else (context and state mutations, notes, policy evaluations, approvals) belongs to
  the span that was active when it happened, expressed by `spanId`.

`buildEventTree` (`packages/core/src/events/tree.ts`) nests an event under its `parentEventId`
if present, otherwise under the opener of its `spanId` (or `parentSpanId` for openers). A
closer's `durationMs` becomes the opener's `spanDurationMs`. The API exposes the flattened tree
at `GET /traces/:traceId/tree`.

## Known event types

25 types are known in schema version 1.0. Payload schemas are lenient (`looseObject`): producers
may attach extra fields.

### Trace lifecycle

| Type              | Emitted when                                                               | `input` / `output`                                       |
| ----------------- | -------------------------------------------------------------------------- | -------------------------------------------------------- |
| `trace.started`   | First event of a trace (`name` = trace name)                               | input `{ name, metadata }`                               |
| `trace.completed` | Program finished; `name` = `"trace.completed"`                             | output `{ outcome: { kind, label, summary? } }`          |
| `trace.failed`    | Program threw, or the outcome kind is `policy_violation`; severity `error` | output `{ outcome?, error?: { message, code?, name? } }` |

Ingesting `trace.completed` or `trace.failed` on the root branch sets the trace status, outcome,
`completedAt` and `durationMs`.

### Agent span

| Type              | Emitted when                                      | Payload                                                                                          |
| ----------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `agent.started`   | Opens the agent span; `name` = agent slug or name | input `{ agent, request? }` (`request` is the original program input; replays read it from here) |
| `agent.completed` | Closes the agent span with `durationMs`           | output `{ outcome }` or `{ error }`                                                              |
| `agent.note`      | `host.note(name, data)`; severity `debug`         | output = `data` (or `null`)                                                                      |

### Model calls

| Type             | Emitted when                                                   | Payload                                                                                             |
| ---------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `model.request`  | Opens a model span; `name` = step name or model                | input `{ provider, model, messages: [{ role, content, name? }], parameters? }`                      |
| `model.response` | Closes it; carries `durationMs`, `tokenUsage`, `estimatedCost` | input `{ provider, model }`; output `{ message, finishReason?, toolCalls?: [{ tool, arguments }] }` |

### Tool calls

| Type            | Emitted when                                                                                   | Payload                                                                         |
| --------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `tool.request`  | Opens a tool span; `name` = tool name                                                          | input `{ tool, arguments }`                                                     |
| `tool.response` | Success; `durationMs`, optional `estimatedCost`                                                | input `{ tool, arguments }`; output `{ result }`                                |
| `tool.error`    | Failure; severity `error` (or `warn` when blocked by a guard policy, `code: "policy_blocked"`) | input `{ tool, arguments }`; output `{ error: { message, code?, retryable? } }` |

A tool call with a `guard` policy records `tool.request`, then `policy.evaluated` (with
`parentEventId` = the request) and its outcome, then either the response or a `tool.error` with
code `policy_blocked`.

### State and context

| Type              | Emitted when                                                                                                                                        | Payload                                                                  |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `state.snapshot`  | `host.snapshot()` (`name` = `"snapshot"`) or automatically every N mutations (`name` = `"auto-snapshot"`, `metadata.auto = true`, severity `debug`) | output `{ state, context }`                                              |
| `state.patch`     | `state.set/remove/replace`; `name` = JSON pointer or `"(root)"`                                                                                     | output `{ ops: [{ op: "add" \| "replace" \| "remove", path, value? }] }` |
| `context.added`   | `context.set(key, value)`; `name` = key                                                                                                             | output `{ key, value }`                                                  |
| `context.removed` | `context.remove(key)`; `name` = key                                                                                                                 | output `{ key }`                                                         |

All four carry `stateVersion`. Mutations that do not change anything are not recorded. See
[State and context](./state-and-context.md).

### Policies

| Type                       | Emitted when                                                                        | Payload                                                                               |
| -------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `policy.evaluated`         | `host.policy()` or a tool guard; `name` = policy id; severity `warn` unless `allow` | input `{ policy, subject, config }`; output `{ policy, decision, reason?, details? }` |
| `policy.allowed`           | decision `allow`; `parentEventId` = evaluation                                      | output `{ policy, decision, reason? }`                                                |
| `policy.denied`            | decision `deny`                                                                     | same                                                                                  |
| `policy.approval_required` | decision `approval_required`                                                        | same                                                                                  |

Decisions are `allow`, `deny` or `approval_required`. When a policy override is active the
evaluation's metadata carries `shadow.overrideKind: "policy"`.

### Human approvals

| Type                       | Emitted when                                                                | Payload                                                                               |
| -------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `human.approval_requested` | `host.requestApproval()`; `name` = `"approval"`; severity `warn`            | input `{ reason, request? }`; output `{ approvalId, reason, status, request? }`       |
| `human.approval_resolved`  | Approval decided (`resolveApproval` in the SDK, approval adapter in replay) | output `{ approvalId, decision: "approved" \| "rejected" \| "pending", resolvedBy? }` |

### Replay and fork bookkeeping

| Type               | Emitted when                                                                                       | Payload                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `fork.created`     | First event of a child branch (`sequence` = `forkSequence + 1`, `source` = `api`, tags `["fork"]`) | input `{ parentBranchId, forkEventId, forkSequence }`; output `{ overrides }` |
| `replay.started`   | Replay begins; `name` = mode                                                                       | input `{ mode, forkId, forkSequence, overrides }`                             |
| `replay.completed` | Replay finished (whatever the program outcome)                                                     | output `{ status, outcome, eventCount }`                                      |
| `replay.failed`    | Replay could not run (history mismatch or engine error); severity `error`                          | output `{ error, details? }`                                                  |

These are _setup events_: they are excluded from replay matching, from fork points and from
comparison alignment. Override mutations (`context.added`, `state.patch`, …) emitted when a fork
goes live carry `metadata.shadow.origin = "override"` and the tag `override`.

## Sources and origins

`source` says who produced the event: the SDK (`sdk`), the API (`api`, for `fork.created` and
server-synthesised rows), a replay (`replay`), an import (`import`) or the seed (`seed`).
`metadata.shadow.origin` says how it came to be (`recorded`, `replay`, `override`, `import`,
`seed`). The two are usually aligned but serve different questions: "which component wrote
this?" versus "is this a real observation or a counterfactual artefact?".

## Example

A guarded tool call recorded by the SDK (ids shortened):

```json
[
  {
    "sequence": 20,
    "eventType": "tool.request",
    "name": "refund_order",
    "spanId": "spn_t1",
    "parentSpanId": "spn_agent",
    "input": { "tool": "refund_order", "arguments": { "orderId": "ord_5001", "amount": 480 } }
  },
  {
    "sequence": 21,
    "eventType": "policy.evaluated",
    "name": "refund.autonomous_limit",
    "spanId": "spn_t1",
    "parentEventId": "evt_20",
    "input": { "policy": "refund.autonomous_limit", "subject": { "amount": 480 }, "config": {} },
    "output": {
      "policy": "refund.autonomous_limit",
      "decision": "allow",
      "reason": "amount $480 is within the autonomous limit of $500"
    }
  },
  {
    "sequence": 22,
    "eventType": "policy.allowed",
    "name": "refund.autonomous_limit",
    "spanId": "spn_t1",
    "parentEventId": "evt_21",
    "output": { "policy": "refund.autonomous_limit", "decision": "allow" }
  },
  {
    "sequence": 23,
    "eventType": "tool.response",
    "name": "refund_order",
    "spanId": "spn_t1",
    "parentSpanId": "spn_agent",
    "parentEventId": "evt_20",
    "durationMs": 900,
    "output": { "result": { "refundId": "rf_5001", "status": "processed" } },
    "estimatedCost": { "amount": 0.002, "currency": "USD" }
  }
]
```
