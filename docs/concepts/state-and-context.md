# State and context

Shadow tracks two documents that together describe "what the agent knows" at any moment:

- **State** is an arbitrary JSON object owned by the program: the request, intermediate results,
  decisions, the current step. It is addressed with JSON pointers (RFC 6901) and mutated with a
  subset of JSON Patch (RFC 6902).
- **Context** is a flat key/value map of facts the agent has learned or been told: customer tier,
  the refund limit it read from a policy document, the region. Context is what overrides most
  often target because it is where "beliefs" live.

Both are event-sourced: they exist only as the result of applying mutation events in order.

## Mutation events

| Operation (AgentHost)     | Event             | `name`                           | `output`                                             |
| ------------------------- | ----------------- | -------------------------------- | ---------------------------------------------------- |
| `state.set(path, value)`  | `state.patch`     | the pointer                      | `{ ops: [{ op: "add" \| "replace", path, value }] }` |
| `state.remove(path)`      | `state.patch`     | the pointer                      | `{ ops: [{ op: "remove", path }] }`                  |
| `state.replace(object)`   | `state.patch`     | `"(root)"`                       | `{ ops: [{ op: "replace", path: "", value }] }`      |
| `context.set(key, value)` | `context.added`   | the key                          | `{ key, value }`                                     |
| `context.remove(key)`     | `context.removed` | the key                          | `{ key }`                                            |
| `snapshot()` / automatic  | `state.snapshot`  | `"snapshot"` / `"auto-snapshot"` | `{ state, context }`                                 |

Rules shared by the SDK (`packages/sdk/src/trace.ts`) and the runtime
(`packages/core/src/runtime/host.ts`, `state/store.ts`):

- A mutation that does not change the document (setting a key to its current value, removing a
  missing path) records nothing.
- Every recorded mutation increments `stateVersion`, which is stamped on the event.
- `set` on a missing path emits `add`; on an existing path `replace`. Intermediate objects are
  created as needed (`/orders/0/id` on an empty state yields `{ orders: { "0": { id } } }` unless
  `/orders` is already an array).
- Patches are applied immutably; readers of `state.get()` receive a clone.

The supported patch operations are `add`, `replace` and `remove`. `move`, `copy` and `test` are
not part of the schema.

## Snapshots

A `state.snapshot` event carries the complete `state` and `context`. Two kinds exist:

- **Explicit**: `host.snapshot()` — good practice at meaningful checkpoints (after reading
  policy, before a side effect, at the end).
- **Automatic**: emitted after every `SnapshotPolicy.everyMutations` mutations (default 25).
  Configure with `snapshotEvery` on the SDK client or `snapshotPolicy` on an `AgentDefinition`;
  `0` disables automatic snapshots in the SDK. Automatic snapshots are marked
  `metadata.auto: true`, have severity `debug`, and replay ignores them when matching program
  operations.

The API mirrors every snapshot into the `state_snapshots` table so reconstruction can start from
the nearest one with an indexed query (see [Storage](../architecture/storage.md#snapshot-strategy)).

## Reconstruction

`reconstructState(events, { upToSequence | upToEventId, useSnapshots })` in
`packages/core/src/state/reconstruct.ts` rebuilds state and context as of an event boundary:

1. Find the latest `state.snapshot` with `sequence <= target` and start from its payload (or from
   empty documents).
2. Apply every later `state.snapshot`, `state.patch`, `context.added` and `context.removed` with
   `sequence <= target`, in order.
3. Return:

```ts
{
  state: JsonObject;
  context: JsonObject;
  stateVersion: number;
  asOfSequence: number; // last applied sequence (-1 when nothing applied)
  fromSnapshotSequence: number | null;
  appliedEvents: number;
}
```

Reconstruction works on a branch's **effective lineage** (inherited prefix plus own events), so a
forked branch sees the parent's mutations before its own. Invalid payloads raise
`StateReconstructionError` naming the offending event.

`stateAround(events, eventId)` returns the state before and after one event; the API exposes it
as `GET /traces/:traceId/events/:eventId/state`, together with structural diffs.

## Diffs

`diffJson(before, after)` produces leaf-level entries:

```ts
{ path: "/refund/status", op: "added" | "removed" | "changed", before?, after? }
```

Identical subtrees are skipped; arrays are compared element by element; paths are JSON pointers
(`formatDiffPath` renders them as `refund.status` for display). Diffs are used in three places:

- state/context before vs after one event (inspector "diff" tab);
- final state/context of two branches (comparison);
- verification that a replayed program reproduced the recorded state at the fork point.

## Access from agent code

The `AgentHost` contract exposes both documents:

```ts
host.context.get("refundLimit"); // JsonValue | undefined
host.context.has("refundLimit");
host.context.all(); // cloned JsonObject
host.context.set("refundLimit", 500);
host.context.remove("refundLimit");

host.state.get(); // cloned JsonObject
host.state.at("/selectedOrder/total");
host.state.set("/step", "decide");
host.state.remove("/draft");
host.state.replace({ step: "done" });
host.snapshot();
```

Read what you need through the host rather than caching values in local variables when the
value should be overridable: in the refund demo the guard policy reads `context.refundLimit`,
which is exactly what the fork overrides.

## Design notes

- Context is deliberately flat. Structured data belongs in state; context keys are meant to be
  readable in the inspector and targetable by `context` overrides.
- State is the program's, not the framework's. Integrations map framework state (a LangGraph
  channel, an OpenAI Agents SDK context object) into it explicitly; see
  [docs/integrations](../integrations/README.md).
- Because every mutation is an event, large or frequent `state.replace` calls are expensive. Use
  targeted `set` calls where possible.
