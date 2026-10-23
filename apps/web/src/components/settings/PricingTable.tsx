"use client";

import { api } from "@/lib/api";
import type { ModelPricing } from "@shadow/schemas";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { EmptyState, ErrorState, Skeleton } from "../ui/primitives";

function perMillion(value: number | undefined): string {
  if (value === undefined) return "–";
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
}

/**
 * The price table the API applies at ingestion (`GET /api/v1/pricing`): built-in list prices
 * plus whatever `SHADOW_PRICING_FILE` adds or overrides, searchable by provider and model.
 */
export function PricingTable() {
  const pricing = useQuery({ queryKey: ["pricing"], queryFn: api.pricing });
  const [search, setSearch] = useState("");
  const [provider, setProvider] = useState("");
  const items = pricing.data?.items ?? [];
  const providers = [...new Set(items.map((p) => p.provider))].sort();
  const needle = search.trim().toLowerCase();
  const shown = items.filter(
    (p) =>
      (!provider || p.provider === provider) &&
      (!needle ||
        p.model.toLowerCase().includes(needle) ||
        p.provider.toLowerCase().includes(needle)),
  );

  return (
    <section className="mb-3 max-w-4xl rounded border border-border bg-panel" data-testid="pricing">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h2 className="text-[12px] font-semibold">Model prices</h2>
        {pricing.data && (
          <span className="text-[11px] text-fg-muted" data-testid="pricing-version">
            catalog {pricing.data.version} · {items.length} model{items.length === 1 ? "" : "s"}
          </span>
        )}
      </header>
      <p className="px-3 pt-2 text-fg-muted">
        USD per million tokens, applied to model spans that arrive without a cost. List prices at
        one point in time: batch tiers, cache writes and partner platforms are not modelled, so
        costs are estimates. <code>SHADOW_PRICING_FILE</code> adds or overrides entries.
      </p>
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <label className="flex items-center gap-1 text-[11px] text-fg-muted">
          Provider
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            className="h-7 rounded border border-border bg-bg px-1 text-[12px] text-fg"
            data-testid="pricing-provider"
          >
            <option value="">All</option>
            {providers.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1 text-[11px] text-fg-muted">
          Model
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="gpt-4o, claude-…"
            className="h-7 w-44 rounded border border-border bg-bg px-2 text-[12px] text-fg"
            data-testid="pricing-search"
          />
        </label>
      </div>
      {pricing.isError ? (
        <ErrorState error={pricing.error} retry={() => pricing.refetch()} />
      ) : !pricing.data ? (
        <div className="space-y-1 p-3" aria-busy="true">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-5 w-full" />
          ))}
        </div>
      ) : shown.length === 0 ? (
        <EmptyState title="No prices match">Clear the provider or model filter.</EmptyState>
      ) : (
        <table className="w-full border-collapse text-[12px]" data-testid="pricing-table">
          <thead className="text-left text-[11px] uppercase tracking-wide text-fg-muted">
            <tr>
              <th className="px-3 py-1">Provider</th>
              <th className="px-3 py-1">Model</th>
              <th className="px-3 py-1 text-right">Input / M</th>
              <th className="px-3 py-1 text-right">Output / M</th>
              <th className="px-3 py-1 text-right">Cached input / M</th>
              <th className="px-3 py-1">Version</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((p: ModelPricing) => (
              <tr
                key={`${p.provider}:${p.model}`}
                className="border-t border-border"
                data-testid="pricing-row"
                data-model={p.model}
              >
                <td className="px-3 py-1">{p.provider}</td>
                <td className="px-3 py-1 font-mono text-[11px]">{p.model}</td>
                <td className="tabular px-3 py-1 text-right">{perMillion(p.inputPerMillion)}</td>
                <td className="tabular px-3 py-1 text-right">{perMillion(p.outputPerMillion)}</td>
                <td className="tabular px-3 py-1 text-right">
                  {perMillion(p.cachedInputPerMillion)}
                </td>
                <td className="px-3 py-1 text-fg-muted">{p.version}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
