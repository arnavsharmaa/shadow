# Replay modes

Shadow distinguishes three kinds of "replay". They share one runtime (`RuntimeHost` in
`packages/core/src/runtime/host.ts`) but make very different guarantees. The decision is recorded
in [ADR 0003](../adr/0003-deterministic-vs-live-replay.md).

| Mode            | What runs                                                                  | Deterministic?                            | Available in v0.1                                   |
| --------------- | -------------------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------- |
| `historical`    | Nothing; recorded events are rendered                                      | Yes, by construction                      | Yes (events endpoints, web app, CLI inspect)        |
| `deterministic` | The registered program against adapters                                    | Yes (virtual clock, seeded ids, adapters) | Yes (`POST /branches/:id/replay`)                   |
| `live`          | The program's `execute`/`evaluate` callbacks against real models and tools | No                                        | Engine only; API returns `501 live_replay_disabled` |

## Historical replay

Historical replay is reading the log: scrub the timeline, inspect any event, reconstruct state at
any boundary, jump to the first error or policy violation. It needs nothing but the events and
works for every trace, including SDK-recorded traces of agents Shadow has never seen.

Requesting `mode: "historical"` on the replay endpoint returns `422 unsupported_mode` because
there is nothing to execute; use `GET /traces/:traceId/events` or `GET /branches/:branchId/events`.

## Deterministic counterfactual replay

Deterministic replay re-executes a **registered agent program** on a forked branch and guarantees
that running it twice yields byte-identical events. This is what makes the difference between two
branches attributable to the fork's overrides.

### What happens

Given a forked branch, `executeReplay` (`packages/core/src/runtime/replay.ts`):

1. **Builds the history**: the parent lineage's events with `sequence <= forkSequence`.
2. **Creates a deterministic environment**: a `VirtualClock` starting at the fork event's
   timestamp, a `seededIdGenerator` seeded with `<branchId>:<replayId>`, adapters from
   `definition.createAdapters({ seed: traceId })`, the definition's pricing provider (default:
   the bundled `shadow-sim` table) and snapshot policy.
3. **Serves the prefix**: the program runs from its start, but every operation it performs is
   matched by a `HistoryCursor` against the next recorded program operation. Recorded results
   (tool responses, model responses, policy decisions, approvals) are returned to the program;
   no new events are emitted for the prefix. Program operations are `tool.request`,
   `model.request`, `policy.evaluated`, `human.approval_requested`, `context.added`,
   `context.removed`, `state.patch`, `state.snapshot` (explicit only) and `agent.note`.
4. **Detects nondeterminism**: if the program performs an operation whose type or name differs
   from the recorded one, or whose recorded input differs (for tool and model requests), the
   cursor throws `ReplayHistoryMismatchError` with the expected and actual type, name, sequence
   and event id, or the recorded versus actual input.
5. **Goes live** when the prefix is exhausted:
   - verifies that the program's state and context equal `reconstructState(history)`; a
     difference is a mismatch (details carry the state and context diffs);
   - applies the fork's `context` and `state` overrides, emitting them as events with
     `metadata.shadow.origin = "override"`;
   - arms `tool_result` / `tool_error` overrides (by occurrence since going live) and `policy`
     overrides (merged into policy config; policy overrides of ancestor forks are inherited).
6. **Continues deterministically** against the adapters, emitting events with `source: "replay"`
   and `metadata.shadow = { origin: "replay", replayId, forkId, scenario }`. Latencies reported
   by adapters advance the virtual clock, so `durationMs` and timestamps are reproducible.
7. **Ends** with `agent.completed`, `trace.completed` or `trace.failed`, and `replay.completed`.
   A mismatch or engine error ends with `replay.failed` (severity `error`) and the branch and
   replay are marked `failed`.

The branch's own events start at `forkSequence + 1` (`fork.created`) and continue from there;
the API removes any previous replay output before running again.

### Determinism guarantees

Given the same trace, fork and registered program version, deterministic replay produces the
same event ids, sequences, timestamps, durations, payloads, token usage and estimated costs.
This holds because:

- time comes from `VirtualClock`, advanced only by adapter-reported latency;
- ids come from `seededIdGenerator`;
- adapters (`ScriptedModelAdapter`, `MockToolAdapter`, `RuleBasedPolicyAdapter`, approval
  adapters) are pure functions of their inputs and the seed;
- the prefix is served from history, never re-executed against adapters;
- the state at the fork point is verified before any override is applied.

### Limits

- **Requires the program.** Replay needs an `AgentDefinition` registered in the API's
  `AgentRegistry`. Traces recorded through the SDK for an unregistered agent can be inspected and
  compared, but `POST /branches/:id/replay` returns `422 agent_not_replayable` (with the list of
  registered slugs in `details.replayable`). `GET /agents` reports `replayable` per agent.
- **Adapters are stand-ins.** A scripted model decides from `parameters.step` and the data the
  program passes; it does not reason. Deterministic replay shows what the _program_ does with
  different inputs, not what a real model would say.
- **Programs must be deterministic with respect to the host.** No `Date.now()`, `Math.random()`,
  environment reads or hidden I/O; everything the program observes must come through the host
  (tools, models, policies, context, state). Otherwise the prefix will not match.
- **Changing the program invalidates old traces for replay.** If the registered program's
  sequence of operations differs from what was recorded (a renamed tool, a reordered step), replay
  of old forks fails with a precise mismatch instead of producing a misleading result.
- **Recorded prefix must be complete.** A `tool.request` without a response or error in the
  history is a mismatch.
- **Automatic snapshots are not matched**; explicit `host.snapshot()` calls are, so adding or
  removing them changes the operation sequence.

### Registering a replayable program

An `AgentDefinition` (`packages/core/src/runtime/types.ts`) bundles the program with factories
for its deterministic adapters:

```ts
import type { AgentDefinition } from "@shadow/core";
import { MockToolAdapter, RuleBasedPolicyAdapter, ScriptedModelAdapter } from "@shadow/testkit";

export const myAgent: AgentDefinition<{ orderId: string }> = {
  slug: "my-agent",                 // must equal the agent slug used when recording
  name: "My Agent",
  description: "…",
  policyConfig: { "orders.limit": { limit: 100 } },   // defaults, overridable per fork
  snapshotPolicy: { everyMutations: 25 },             // optional
  createAdapters: ({ seed }) => ({
    model: new ScriptedModelAdapter({ decide: (req) => ({ text: "…", latencyMs: 300 }) }),
    tools: new MockToolAdapter({ lookup_order: (args) => ({ result: { … }, latencyMs: 120 }) }),
    policies: new RuleBasedPolicyAdapter({ "orders.limit": (subject, ctx) => ({ decision: "allow" }) }),
    approvals: undefined,           // optional; default leaves approvals pending
  }),
  async program(host, input) {
    host.state.set("/request", input);
    const order = await host.tool({ name: "lookup_order", arguments: { id: input.orderId } });
    …
    return { kind: "completed", label: "Done" };
  },
};
```

Register it in `apps/api/src/replay/registry.ts` (`createDefaultRegistry` adds the testkit
scenarios; add `registry.register(myAgent)`). The program signature is the `AgentHost` contract,
so the same function can be run live through the SDK (`trace.run(program, input)` with
`withAdapters` from the testkit if the calls lack `execute` callbacks) and recorded from scratch
with `recordExecution` for tests and seeds.

The five bundled definitions (`refund-agent`, `inventory-agent`, `support-faq-agent`,
`enrichment-agent`, `access-request-agent`) plus `synthetic-load-agent` are examples of the
pattern.

## Live re-execution

The runtime supports `execution: "callbacks"`: instead of adapters, it invokes the `execute`
callback on each `ToolCall` and `ModelCall` and the `evaluate` callback on each `PolicyCall`,
that is, the real implementations the program uses when recorded through the SDK. The history
cursor and override machinery are identical; only the post-fork execution differs.

Live replay is nondeterministic by nature (real models, real time, real side effects) and can
cost money or trigger actions. It is therefore disabled in the v0.1 API (`mode: "live"` returns
`501 live_replay_disabled`). Enabling it, with explicit warnings, cost guards and side-effect
policies, is planned for v0.4 (see [ROADMAP.md](../../ROADMAP.md)).

## Choosing a mode

- To understand what happened: historical.
- To test a hypothesis about the program's logic, policies, tool failures or the agent's beliefs:
  deterministic, with a registered program.
- To reproduce a real model's behaviour under changed conditions: live, once available; until
  then, record a new trace with the changed input through the SDK and compare traces manually.
