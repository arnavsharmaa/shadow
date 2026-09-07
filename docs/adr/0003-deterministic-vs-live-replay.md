# 0003. Deterministic versus live replay

- **Status:** Accepted
- **Date:** 2026-09-03
- **Deciders:** Shadow maintainers

## Context

"Replay" means different things to different users:

- rendering what happened (a log viewer with a scrubber);
- re-running the agent from a fork point with something changed, to see what _would_ have
  happened;
- re-running the agent against the real model and real tools to reproduce a bug in production
  conditions.

The second is the core value of a time-travel debugger, and it is only useful if two replays of
the same fork produce the same result, otherwise a user cannot tell whether a difference comes
from the override or from noise. Language models are nondeterministic, tools have side effects
(a refund is issued, an email is sent) and wall-clock time and random ids leak into payloads.

At the same time, some users will legitimately want live re-execution, and the architecture
should not preclude it.

## Decision

We will support **three replay modes**, implemented over one runtime, and make deterministic
counterfactual replay the default and only executing mode in v0.1.

1. **Historical replay** renders recorded events. Nothing executes; it is deterministic by
   construction and works for any trace, including SDK-recorded traces of unknown agents.
2. **Deterministic counterfactual replay** re-runs a **registered agent program** under
   `RuntimeHost` with `execution: "adapters"`:
   - A `HistoryCursor` serves the recorded prefix (up to `forkSequence`) to the program. Each
     program operation (`tool.request`, `model.request`, `policy.evaluated`,
     `human.approval_requested`, context and state mutations, notes) must match the next recorded
     operation by type, name and, where recorded, input. Any mismatch aborts with a
     `ReplayHistoryMismatchError` naming the expected and actual operation and sequence.
   - When the prefix is exhausted the runtime "goes live": it verifies that the program's state
     and context equal the reconstruction of the recorded prefix at the fork point, then applies
     the fork's context and state overrides, emitting them as events with
     `metadata.shadow.origin = "override"`.
   - From there the program continues against **deterministic adapters** supplied by the agent
     definition (`ScriptedModelAdapter`, `MockToolAdapter`, `RuleBasedPolicyAdapter`, approval
     adapters). Tool result and tool error overrides intercept the Nth occurrence of a tool after
     the fork; policy overrides merge into the policy configuration.
   - A `VirtualClock` starting at the fork event's timestamp and a `seededIdGenerator` seeded
     with the branch and replay ids make ids, timestamps and durations byte-identical across
     runs.
3. **Live re-execution** uses the same runtime with `execution: "callbacks"`, so a program's
   `execute`/`evaluate` callbacks run against real models and tools. The API returns
   `501 live_replay_disabled` for `mode: "live"` in v0.1; enabling it is a v0.4 item together
   with cost guards and nondeterminism warnings.

Replay therefore requires the agent's program. Programs are registered in the API's
`AgentRegistry`; traces recorded through the SDK for agents that are not registered can be
inspected and compared but not forked-and-replayed (`422 agent_not_replayable`).

## Consequences

Positive:

- Two replays of the same fork are identical, so every difference between branches is
  attributable to the overrides. This is what makes branch comparison meaningful.
- The history cursor turns nondeterminism into a precise, early failure instead of a silently
  wrong counterfactual. The failure is recorded as a `replay.failed` event with details.
- The same `AgentHost` contract serves recording (SDK), seeding (core with adapters) and replay,
  so a program written once is replayable without changes.
- No real side effects during replay: no refunds, no emails, no spend on model calls.

Negative:

- Replay is only available for agents whose program is registered in the API process. Bringing
  your own agent means packaging it as an `AgentDefinition` with deterministic adapters.
- Adapters are stand-ins: a scripted model will not reveal how a real model would react to a
  changed prompt. Deterministic replay answers "what would the program have done with this
  input", not "what would the model have said".
- Programs must be deterministic with respect to the host: no reading `Date.now()`, no random
  ids, no branching on data the host does not see. Violations surface as mismatches.
- Registering programs couples the API deployment to agent code. A registry loaded from
  configuration or plugins is future work.

Neutral:

- Historical replay is the mode users encounter first; the UI treats it as "viewing a trace"
  rather than as a replay.

## Alternatives considered

- **Live re-execution as the default.** Matches the intuition "run it again" but yields
  non-reproducible comparisons and real side effects. Rejected as a default; kept as an opt-in
  mode with the architecture in place.
- **Record/replay of model responses only (no program).** Treat recorded `model.response` events
  as the model and re-execute only tools. Works for SDK traces without a registered program, but
  as soon as an override changes what the model would be asked, there is no recorded answer to
  serve. Under consideration for v0.4 as a partial mode; not sufficient alone.
- **Snapshot-and-continue (process checkpointing).** Capture the agent process at the fork point
  and resume it. Runtime-specific, fragile across versions and impossible for remote models.
  Rejected.
- **Silently tolerating history mismatches.** Continue replay after a mismatch by serving the
  closest recorded event. Produces plausible but wrong counterfactuals. Rejected in favour of
  aborting with a precise error.
