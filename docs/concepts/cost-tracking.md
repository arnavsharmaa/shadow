# Cost tracking

Shadow records token usage on model responses, attaches **estimated** costs to model and tool
events, aggregates them per branch and reports deltas between branches. Costs are always
labelled as estimates: they come from a pricing table, not from a vendor's invoice.

## Where costs live

- **`event.tokenUsage`** on `model.response`: `{ inputTokens, outputTokens, totalTokens,
cachedInputTokens? }`, as reported by the model implementation (SDK `execute` callback or a
  `ModelAdapter`).
- **`event.estimatedCost`** on `model.response` and `tool.response`:

  ```ts
  { amount: number, currency: "USD", provider?: string, model?: string, pricingVersion?: string }
  ```

- **`branch.metrics`** (and `trace.metrics` for the root branch), the "cost record":

  ```ts
  {
    (eventCount,
      modelCalls,
      toolCalls,
      toolErrors,
      policyEvaluations,
      inputTokens,
      outputTokens,
      totalTokens,
      estimatedModelCost,
      estimatedToolCost,
      totalEstimatedCost,
      durationMs,
      currency);
  }
  ```

  computed by `aggregateMetrics` over the branch's effective lineage and stored whenever events
  are ingested, replayed or imported.

- **`comparison.result.metrics`**: per-metric `{ base, target, delta, percent }`.

## How model costs are estimated

The engine uses a `PricingProvider` (`packages/core/src/metrics/pricing.ts`):

```ts
interface PricingProvider {
  lookup(provider: string, model: string): ModelPricing | undefined;
  readonly version: string;
}
```

`ModelPricing` is a price per one million tokens:

```ts
{ provider, model, inputPerMillion, outputPerMillion, cachedInputPerMillion?, currency, version }
```

`estimateModelCost(usage, pricing)` computes

```
(uncachedInput * inputPerMillion + cachedInput * cachedRate + outputTokens * outputPerMillion) / 1e6
```

where `cachedInput = usage.cachedInputTokens ?? 0`, `uncachedInput = inputTokens - cachedInput`,
and `cachedRate` falls back to `inputPerMillion` when no cached price exists. Amounts are rounded
to 8 decimal places. When the provider/model pair is unknown the estimate is `null`; the token
usage is still recorded.

`StaticPricingProvider` holds a table in memory; an `AgentDefinition` may supply its own
`pricing`. The default provider is `defaultPricingProvider`, which contains **fictional pricing
for the bundled simulator**:

| Provider     | Model              | Input / M | Output / M | Version    |
| ------------ | ------------------ | --------- | ---------- | ---------- |
| `shadow-sim` | `sim-support-1`    | 2.50      | 10.00      | sim-2026.1 |
| `shadow-sim` | `sim-support-mini` | 0.40      | 1.60       | sim-2026.1 |

These numbers are invented for the demo and are not any vendor's prices. Real provider pricing
tables are a roadmap item; until then, supply your own table or compute costs in your model
implementation.

## Costs supplied by the caller

Both the SDK and the runtime accept a caller-provided estimate:

- `ModelResult.estimatedCost?: number` — the SDK records it as
  `{ amount, currency: "USD", provider, model }` without consulting a pricing table (the SDK has
  no pricing provider; the API does not recompute costs). The core runtime, by contrast, derives
  the cost from its pricing provider and the reported `tokenUsage`.
- `ToolResult.estimatedCost?: number` — recorded on `tool.response` as `{ amount, currency:
"USD" }`. Use it for paid APIs (the enrichment demo charges 0.05 per `enrich_company` call; the
  refund demo charges 0.002 per `refund_order`).

## Aggregation rules

`aggregateMetrics(events)`:

- counts `model.request`, `tool.request`, `tool.error` and `policy.evaluated` events;
- sums `tokenUsage` over all events that carry it;
- adds `estimatedCost.amount` to `estimatedModelCost` for `model.*` events and to
  `estimatedToolCost` otherwise; `totalEstimatedCost` is their sum;
- takes the last non-empty `estimatedCost.currency` as the branch currency (mixed currencies are
  not converted);
- sets `durationMs` to the range between the earliest and latest event timestamps.

Inherited events count towards a fork's metrics, so a fork's cost includes the shared prefix;
the comparison delta is what the fork changed.

## Using costs

- Trace explorer: filter with `minCost`, sort by `totalEstimatedCost` or `totalTokens`.
- Trace detail: summary shows tokens and estimated cost; the event inspector shows per-call
  usage and cost.
- Comparison view: cost, token and latency deltas between branches (for the refund demo the fork
  is cheaper because the refund tool is never called and the email is shorter).
- CLI: `shadow traces list --json` includes `metrics` for scripting.

## Caveats

- Estimates depend on the pricing table version recorded in `pricingVersion`; re-pricing old
  traces is not automatic.
- Replayed branches price adapter completions with the definition's provider, so a replay of a
  live-recorded trace may use a different table than the original.
- Costs are a debugging aid, not a billing record.
