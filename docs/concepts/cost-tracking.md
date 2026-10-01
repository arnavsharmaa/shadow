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

  computed by `aggregateMetrics` over the branch's effective lineage. The API keeps it up to
  date incrementally (`mergeMetrics` on ingestion, inherited prefix on fork, engine aggregate on
  replay) and recomputes it in full on import.

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

These numbers are invented for the demo and are not any vendor's prices.

### Prices for traces recorded elsewhere

Events that reach the API with token usage but no cost (SDK callers without a price table, OTLP
spans, imported conversations) are priced at ingestion. The API finds the `model.request` that
opened the response's span, in the same batch or already stored, and looks its `provider` and
`model` up in a `CatalogPricingProvider`. A cost supplied by the caller is never replaced, and
an unknown model stays unpriced (`estimatedCost: null`).

The built-in catalog (`builtinPricingProvider`) holds the simulator's prices and **Anthropic's
first-party API list prices as published on 2026-09-25**, in USD per million tokens:

| Model               | Input | Output | Cache read |
| ------------------- | ----- | ------ | ---------- |
| `claude-fable-5-1`  | 10.00 | 50.00  | 0.25       |
| `claude-fable-5`    | 10.00 | 50.00  | 1.00       |
| `claude-opus-5-5`   | 4.00  | 20.00  | 0.20       |
| `claude-opus-5`     | 5.00  | 25.00  | 0.50       |
| `claude-opus-4-8`   | 5.00  | 25.00  | 0.50       |
| `claude-opus-4-7`   | 5.00  | 25.00  | 0.50       |
| `claude-opus-4-6`   | 5.00  | 25.00  | 0.50       |
| `claude-sonnet-5-5` | 2.00  | 10.00  | 0.20       |
| `claude-sonnet-5`   | 2.00  | 10.00  | 0.20       |
| `claude-sonnet-4-6` | 3.00  | 15.00  | 0.30       |
| `claude-haiku-4-5`  | 1.00  | 5.00   | 0.10       |

Cache reads use the published rate where one is listed and a tenth of the input price
otherwise. Lookups ignore case, a platform prefix (`anthropic.claude-opus-5-5`) and a dated
snapshot suffix (`claude-haiku-4-5-20251001`); when the event's provider is not in the catalog
at all (`unknown`, `aws.bedrock`), the model id alone is used if only one provider lists it.

These are list prices at one point in time. Batch discounts, cache writes (billed above the
input rate, counted here at the input rate), long-context or fast-mode premiums and partner
platform pricing are not modelled, so treat the result as an estimate. To correct or extend the
table, point `SHADOW_PRICING_FILE` at a JSON array of
`{ provider, model, inputPerMillion, outputPerMillion, cachedInputPerMillion?, currency?,
version? }`; its entries add to or replace the built-in ones. `GET /api/v1/pricing` and `shadow
pricing` show the table in use. No other vendor's prices are bundled.

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
