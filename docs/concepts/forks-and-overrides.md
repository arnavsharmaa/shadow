# Forks and overrides

A **fork** creates a new branch that shares history with its parent up to a chosen event and
diverges from there with a set of typed **overrides**. Replaying the fork answers "what would
this agent have done if X had been different?".

## Branch lineage

Every trace has a root branch named `main`. A child branch stores only the events after its fork
point and inherits the rest:

```
effective(child) = { e in effective(parent) | e.sequence <= child.forkSequence } ++ own(child)
```

Fields on `Branch`:

| Field            | Meaning                                                                           |
| ---------------- | --------------------------------------------------------------------------------- |
| `parentBranchId` | the branch it was forked from (`null` for the root)                               |
| `forkId`         | the `Fork` record with the overrides                                              |
| `forkEventId`    | the first event of the parent lineage that is **re-executed** on this branch      |
| `forkSequence`   | the last sequence **inherited** from the parent (`forkEvent.sequence - 1`)        |
| `depth`          | 0 for the root, parent depth + 1 otherwise                                        |
| `status`         | `recording`, `pending` (forked, not replayed), `replaying`, `completed`, `failed` |

Forks can be nested: a branch forked from a fork inherits both prefixes. Deleting a branch deletes
its descendants. The web app renders the lineage as a branch DAG.

## Choosing a fork point

`POST /traces/:traceId/forks` takes a `forkEventId`. The engine (`resolveForkPoint` in
`packages/core/src/branches/fork.ts`) normalises the selection to an **operation boundary** so
that the re-executed program starts at a point where it can make a different decision:

- Selecting a **closer** (`tool.response`, `tool.error`, `model.response`, `policy.allowed`,
  `policy.denied`, `policy.approval_required`, `human.approval_resolved`) forks at its opener.
- Selecting an event nested inside a tool span (for example a guard `policy.evaluated`) forks at
  the enclosing `tool.request`.
- Selecting a setup event (`fork.created`, `replay.*`, or any event with origin `override`) is
  rejected with `422 not_forkable`.

The selected event is kept in `fork.metadata.selectedEventId`; `forkEventId` is the normalised
one. In the canonical demo the user selects the `refund_order` tool request; the branch inherits
everything before it, including the policy document the agent read, and re-executes the refund
decision.

## The Fork record

```ts
{
  id: "frk_…",
  traceId, parentBranchId, childBranchId,
  forkEventId, forkSequence,
  overrides: Override[],      // ids default to "ovr_1", "ovr_2", …
  createdAt,
  metadata: { selectedEventId }
}
```

The child branch's first event is `fork.created` at `sequence = forkSequence + 1`, whose input
records the fork point and whose output lists the overrides. It exists so an exported branch is
self-describing.

## Override kinds

Overrides are a discriminated union (`packages/schemas/src/overrides.ts`). Each has an optional
`id` and human-readable `label`.

### `context` — change what the agent knows

```json
{ "kind": "context", "op": "set", "key": "refundLimit", "value": 100 }
{ "kind": "context", "op": "remove", "key": "refundPolicy" }
```

Applied when the replay reaches the fork point, before the program continues. Recorded as a
`context.added` / `context.removed` event with `metadata.shadow.origin = "override"` and tag
`override`.

### `state` — change the program state

```json
{ "kind": "state", "op": "set", "path": "/selectedOrder/refundable", "value": false }
{ "kind": "state", "op": "remove", "path": "/draft" }
```

`path` is a JSON pointer (`""` addresses the whole document). Recorded as a `state.patch` event
with origin `override`.

### `tool_result` — substitute a tool's result

```json
{
  "kind": "tool_result",
  "tool": "inventory.lookup",
  "occurrence": 1,
  "result": { "sku": "SKU-7781", "available": 120 }
}
```

Intercepts the `occurrence`-th call (1-based, default 1) to `tool` **after the fork point**. The
recorded `tool.request` is emitted normally; the `tool.response` carries the substituted result,
`latencyMs` 0 and `metadata.shadow` naming the override. Guard policies still run first.

### `tool_error` — make a tool fail

```json
{
  "kind": "tool_error",
  "tool": "refund_order",
  "occurrence": 1,
  "error": { "message": "gateway timeout", "code": "ETIMEDOUT", "retryable": true }
}
```

The program receives a `ToolExecutionError`; a `tool.error` event with the override metadata is
recorded. Useful for exercising retry and fallback paths.

### `policy` — reconfigure a policy

```json
{ "kind": "policy", "policy": "refund.autonomous_limit", "config": { "limit": 100 } }
```

Merged on top of the agent definition's default `policyConfig` and the call's own `config` for
every evaluation of that policy after the fork. The `policy.evaluated` event records the effective
`config` in its input and `metadata.shadow.overrideKind = "policy"`. Policy overrides are
**inherited** by nested forks; other override kinds are not (they are already reflected in the
parent branch's events, which the nested fork inherits).

## Lifecycle

1. `POST /traces/:traceId/forks` creates the branch (`status: "pending"`), the fork record and
   the `fork.created` event. Nothing executes.
2. `POST /branches/:branchId/replay` runs the deterministic replay (see
   [Replay modes](./replay-modes.md)); the branch becomes `completed` or `failed` and receives
   its own events, outcome and metrics.
3. `POST /comparisons` compares the fork with its parent (or any other branch of the trace).
4. `PATCH /branches/:branchId` renames a branch; `DELETE` removes it and its descendants.

From the CLI: `shadow fork <traceId> --at <eventId> --set key=value …` creates a fork with
context overrides, `shadow replay <branchId>` replays it and `shadow compare <base> <target>`
compares.

## Worked example: the refund agent

Root branch (`main`):

1. The agent reads a stale policy document that says the autonomous refund limit is $500 and
   stores it as `context.refundLimit = 500`.
2. It calls `refund_order` for $480 with the guard policy `refund.autonomous_limit`, which reads
   `context.refundLimit`; decision `allow`; the refund is processed.
3. A compliance audit (`compliance.refund_limit`, configured with the real limit of $100) denies
   the executed refund; the outcome is `policy_violation` and the trace ends with
   `trace.failed`.

Fork at the `refund_order` request with `{ kind: "context", op: "set", key: "refundLimit",
value: 100 }`:

1. The replay serves the recorded prefix, verifies state at the fork point and emits the override
   as a `context.added` event.
2. The guard now returns `approval_required`; the tool call fails with `policy_blocked`; the
   agent requests human approval (pending), emails the customer that the refund is under review
   and passes the compliance audit because no autonomous refund was executed.
3. The outcome is `approval_pending` ("Approval requested") and the trace completes.

The comparison reports the first divergence at `policy.evaluated refund.autonomous_limit`
(`output.decision` changed from `allow` to `approval_required`), a removed `refund_order`
response, added approval events, a lower estimated cost (no refund tool cost) and a shorter
duration.
