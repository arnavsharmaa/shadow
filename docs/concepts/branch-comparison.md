# Branch comparison

The comparison engine (`compareBranches` in `packages/core/src/comparison/compare.ts`) explains
how two branches of the same trace differ: where they diverge first, which steps were added,
removed or modified, how tool calls, context, state, metrics, outcome and policy decisions
changed. Results are stored by `POST /api/v1/comparisons` and rendered by the web app's
comparison view.

## Inputs

Two sides, each a `Branch` with its **effective lineage** (inherited prefix plus own events,
sorted by sequence), plus the overrides of the fork involved (the target's fork, or the base's if
the target is not a fork). Base and target may be any two distinct branches of one trace; the
common case is `main` versus a fork.

## Algorithm

1. **Shared prefix.** Walk both lineages in parallel while event ids are equal;
   `sharedUntilSequence` is the sequence of the last shared event (`-1` if none). Because forks
   inherit events by reference, the shared prefix is an identity, not a payload comparison.
2. **Setup steps.** In the target suffix, `fork.created`, `replay.*` and override-origin events
   are separated out as `override` steps: they explain the divergence but are not program
   behaviour. Setup events are also excluded from the base suffix.
3. **Alignment.** The remaining suffixes are aligned on the signature `"<eventType> <name>"`
   using longest common subsequence. When the product of the suffix lengths exceeds
   `maxDpCells` (default 4 000 000), a windowed greedy alignment (lookahead 64) is used instead
   to bound memory and time on very large traces.
4. **Classification.** Each aligned pair becomes a step:
   - `shared`: identical event in both (prefix);
   - `override`: setup event on the target;
   - `same`: same signature and no field differences;
   - `modified`: same signature but `diffEventFields` found differences in `eventType`, `name`,
     `output`, `input` or `severity` (ids, timestamps, durations and metadata are ignored);
   - `added`: only in the target; `removed`: only in the base.
5. **First divergence.** The first step that is not `same`, with a reason derived from the
   diff: `type_changed`, `name_changed`, `output_changed`, `input_changed`, `event_added`,
   `event_removed`, and a one-line summary such as
   `policy.evaluated 'refund.autonomous_limit': output.decision changed from "allow" to "approval_required"`.
6. **Tool calls.** `summariseToolCalls` pairs every `tool.request` with its response or error.
   Calls are matched by `tool#occurrence` across branches; diffs are reported as `arguments`,
   `result`, `status` (ok/error changed), `added` or `removed`.
7. **Context and state.** `reconstructState` on both lineages; `diffJson` on the final context and
   state documents.
8. **Metrics.** `aggregateMetrics` on both lineages; deltas for total/input/output tokens,
   estimated cost, duration, tool calls, model calls and event count, each as
   `{ base, target, delta, percent | null }`.
9. **Outcome and policy.** The branch outcome (or the outcome derived from the last trace end
   event); counts and ordered lists of policy decisions per branch, with `changed` flags.

## Result shape

```ts
{
  base:   { branchId, name, metrics, outcome, eventCount },
  target: { branchId, name, metrics, outcome, eventCount },
  sharedUntilSequence: number,
  overrides: Override[],
  firstDivergence: {
    stepIndex, sequence, reason, summary,
    base: EventRef | null, target: EventRef | null,
    fields: [{ path, before?, after? }]
  } | null,
  steps: [{ index, kind, base: EventRef | null, target: EventRef | null, fields }],
  addedEvents: EventRef[],
  removedEvents: EventRef[],
  modifiedEvents: [{ base, target, fields }],
  toolCalls: { base: ToolCallSummary[], target: ToolCallSummary[], diffs: ToolCallDiff[] },
  context: { diff: DiffEntry[] },
  state:   { diff: DiffEntry[] },
  metrics: { totalTokens, inputTokens, outputTokens, totalEstimatedCost, durationMs, toolCalls, modelCalls, eventCount },
  outcome: { base, target, changed },
  policy:  { base: counts, target: counts, baseDecisions, targetDecisions, changed }
}
```

`EventRef` is `{ id, branchId, sequence, eventType, name, timestamp, durationMs }`. Field paths
are dotted (`output.decision`, `input.arguments.amount`).

## Reading a comparison

For the canonical refund demo (`main` versus `fork-1` with `refundLimit = 100`):

- `sharedUntilSequence` is the sequence just before the `refund_order` request.
- `overrides` lists the context override; the first `override` step is the `fork.created` event
  followed by the `context.added refundLimit` override event.
- `firstDivergence`: `policy.evaluated refund.autonomous_limit`, reason `output_changed`,
  `output.decision` `allow` -> `approval_required`.
- `removedEvents` include the `refund_order` `tool.response`; `addedEvents` include the
  `tool.error` (`policy_blocked`), `human.approval_requested` and the `policy.approval_required`
  outcome.
- `toolCalls.diffs`: `refund_order#1` with kind `status` (ok -> error); `send_email#1` with kind
  `arguments` (different subject and body).
- `context.diff`: `/refundLimit` changed 500 -> 100. `state.diff`: `/refund`, `/approval`,
  `/email` differ.
- `metrics.totalEstimatedCost.delta` is negative (no refund tool cost, shorter email) and
  `durationMs.delta` is negative.
- `outcome.changed` is true (`policy_violation` -> `approval_pending`); `policy.changed` is true.

## Notes and limits

- Alignment uses signatures, not payloads; a step that changed its tool or model name shows as
  removed + added rather than modified. This is intentional: a different operation is a different
  step.
- Repeated identical signatures (loops) align by LCS order, which is usually right but can pair
  the wrong iterations when loop counts differ; the tool-call view by occurrence is the more
  precise lens in that case.
- Comparisons are computed once and stored; if a branch is replayed again, create a new
  comparison.
- `metrics.durationMs` is the timestamp range of each lineage, so a fork replayed with a virtual
  clock is comparable with the recorded branch only to the extent adapter latencies are realistic.
