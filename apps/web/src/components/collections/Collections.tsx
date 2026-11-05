"use client";

import { api } from "@/lib/api";
import { classNames, dateTime, duration, money, percent, relativeTime } from "@/lib/format";
import type { Collection, TraceSummary } from "@shadow/schemas";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Skeleton,
  outcomeTone,
  statusTone,
} from "../ui/primitives";

/** Collections: named groups of traces (batches, experiments, incidents) and their members. */
export function Collections() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const selected = params.get("collection");
  const queryClient = useQueryClient();
  const collections = useQuery({ queryKey: ["collections"], queryFn: () => api.collections() });
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["collections"] });
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  const select = (value: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (value) next.set("collection", value);
    else next.delete("collection");
    router.replace(`${pathname}?${next.toString()}`);
  };
  const create = useMutation({
    mutationFn: () => api.createCollection(name.trim(), [], description.trim() || undefined),
    onSuccess: async (result) => {
      setName("");
      setDescription("");
      setError(null);
      await refresh();
      select(result.collection.name);
    },
    onError: fail,
  });

  const items = collections.data?.items ?? [];
  const current = items.find((c) => c.name === selected) ?? null;

  return (
    <div className="flex h-full flex-col" data-testid="collections">
      <div className="flex flex-wrap items-center gap-3 border-b border-border bg-panel px-3 py-2 text-[12px]">
        <h1 className="text-[13px] font-semibold">Collections</h1>
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate();
          }}
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="new collection"
            maxLength={64}
            aria-label="Collection name"
            className="h-7 w-44 rounded border border-border bg-bg px-2"
            data-testid="new-collection-name"
          />
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="description (optional)"
            maxLength={500}
            aria-label="Collection description"
            className="h-7 w-64 rounded border border-border bg-bg px-2"
            data-testid="new-collection-description"
          />
          <Button
            type="submit"
            size="xs"
            variant="primary"
            disabled={!name.trim() || create.isPending}
            data-testid="create-collection"
          >
            Create
          </Button>
        </form>
        {error && (
          <span className="text-[11px] text-err" role="alert" data-testid="collections-error">
            {error}
          </span>
        )}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(240px,1fr)_2fr] overflow-hidden text-[12px]">
        <div className="min-h-0 overflow-auto border-r border-border">
          {collections.isError ? (
            <ErrorState error={collections.error} retry={() => collections.refetch()} />
          ) : !collections.data ? (
            <div className="space-y-1 p-3" aria-busy="true">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <EmptyState title="No collections yet">
              Create one above, tick traces in the explorer and add them, or use `shadow collections
              create`.
            </EmptyState>
          ) : (
            <ul data-testid="collection-list">
              {items.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => select(c.name)}
                    className={classNames(
                      "flex w-full items-baseline justify-between gap-2 border-b border-border px-3 py-2 text-left hover:bg-hover",
                      c.name === selected && "bg-hover",
                    )}
                    aria-current={c.name === selected ? "true" : undefined}
                    data-testid="collection-item"
                    data-collection-name={c.name}
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{c.name}</span>
                      {c.description && (
                        <span className="block truncate text-[11px] text-fg-muted">
                          {c.description}
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 text-right text-[11px] text-fg-muted">
                      <span className="block">
                        {c.traceCount} trace{c.traceCount === 1 ? "" : "s"}
                      </span>
                      {c.traceCount > 0 && (
                        <span className="block text-fg-faint" data-testid="collection-stats">
                          {c.stats.failed > 0 && (
                            <span className="text-err">{c.stats.failed} failed · </span>
                          )}
                          {money(c.stats.totalEstimatedCost)}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="min-h-0 overflow-auto">
          {current ? (
            <CollectionDetail
              collection={current}
              others={items.filter((c) => c.id !== current.id)}
              onChanged={refresh}
              onDeleted={() => {
                select(null);
                void refresh();
              }}
              onError={fail}
            />
          ) : (
            <EmptyState title="Pick a collection">
              Its traces, description and actions appear here.
            </EmptyState>
          )}
        </div>
      </div>
    </div>
  );
}

/** `current` relative to `previous` as a signed percentage; "new" when there was nothing before. */
function relativeChange(current: number, previous: number): string {
  if (previous === 0) return current === 0 ? "0.0%" : "new";
  return percent((current - previous) / previous);
}

/** Two collections' totals side by side, the change being `left` relative to `right`. */
function CollectionComparison({ left, right }: { left: Collection; right: Collection }) {
  const finished = (c: Collection) => c.stats.completed + c.stats.failed;
  const failureRate = (c: Collection) => (finished(c) === 0 ? null : c.stats.failed / finished(c));
  const avgCost = (c: Collection) =>
    c.traceCount === 0 ? 0 : c.stats.totalEstimatedCost / c.traceCount;
  const rate = (value: number | null) => (value === null ? "n/a" : `${(value * 100).toFixed(1)}%`);
  const rows: { key: string; label: string; left: string; right: string; change: string }[] = [
    {
      key: "traces",
      label: "Traces",
      left: String(left.traceCount),
      right: String(right.traceCount),
      change: relativeChange(left.traceCount, right.traceCount),
    },
    {
      key: "failed",
      label: "Failed",
      left: String(left.stats.failed),
      right: String(right.stats.failed),
      change: relativeChange(left.stats.failed, right.stats.failed),
    },
    {
      key: "failureRate",
      label: "Failure rate",
      left: rate(failureRate(left)),
      right: rate(failureRate(right)),
      change: "",
    },
    {
      key: "cost",
      label: "Est. cost",
      left: money(left.stats.totalEstimatedCost),
      right: money(right.stats.totalEstimatedCost),
      change: relativeChange(left.stats.totalEstimatedCost, right.stats.totalEstimatedCost),
    },
    {
      key: "avgCost",
      label: "Avg cost / trace",
      left: money(avgCost(left)),
      right: money(avgCost(right)),
      change: relativeChange(avgCost(left), avgCost(right)),
    },
    {
      key: "tokens",
      label: "Tokens",
      left: left.stats.totalTokens.toLocaleString(),
      right: right.stats.totalTokens.toLocaleString(),
      change: relativeChange(left.stats.totalTokens, right.stats.totalTokens),
    },
  ];
  return (
    <table className="mt-2 w-full max-w-xl border-collapse" data-testid="collection-comparison">
      <thead className="text-left text-[11px] uppercase tracking-wide text-fg-muted">
        <tr>
          <th className="py-1 pr-3">Metric</th>
          <th className="py-1 pr-3 text-right">{left.name}</th>
          <th className="py-1 pr-3 text-right">{right.name}</th>
          <th className="py-1 text-right">Change</th>
        </tr>
      </thead>
      <tbody className="tabular">
        {rows.map((row) => (
          <tr key={row.key} className="border-t border-border" data-metric={row.key}>
            <td className="py-1 pr-3">{row.label}</td>
            <td className="py-1 pr-3 text-right">{row.left}</td>
            <td className="py-1 pr-3 text-right">{row.right}</td>
            <td className="py-1 text-right text-fg-muted">{row.change}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CollectionDetail({
  collection,
  others,
  onChanged,
  onDeleted,
  onError,
}: {
  collection: Collection;
  /** The other collections, offered for a side-by-side comparison. */
  others: Collection[];
  onChanged: () => void;
  onDeleted: () => void;
  onError: (error: unknown) => void;
}) {
  const queryClient = useQueryClient();
  const traces = useQuery({
    queryKey: ["collection-traces", collection.name],
    queryFn: () => api.listTraces({ collection: collection.name, limit: 100 }),
  });
  const tools = useQuery({
    queryKey: ["collection-tools", collection.name],
    queryFn: () => api.toolStats({ collection: collection.name }),
  });
  const models = useQuery({
    queryKey: ["collection-models", collection.name],
    queryFn: () => api.modelStats({ collection: collection.name }),
  });
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(collection.name);
  const [draftDescription, setDraftDescription] = useState(collection.description ?? "");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [compareWith, setCompareWith] = useState("");
  const other = others.find((c) => c.name === compareWith) ?? null;
  const refreshTraces = () =>
    queryClient.invalidateQueries({ queryKey: ["collection-traces", collection.name] });

  const update = useMutation({
    mutationFn: () =>
      api.updateCollection(collection.name, {
        ...(draftName.trim() !== collection.name ? { name: draftName.trim() } : {}),
        ...(draftDescription.trim() !== (collection.description ?? "")
          ? { description: draftDescription.trim() || null }
          : {}),
      }),
    onSuccess: () => {
      setEditing(false);
      onChanged();
    },
    onError,
  });
  const remove = useMutation({
    mutationFn: (traceId: string) => api.removeFromCollection(collection.name, traceId),
    onSuccess: async () => {
      await refreshTraces();
      onChanged();
    },
    onError,
  });
  const destroy = useMutation({
    mutationFn: () => api.deleteCollection(collection.name),
    onSuccess: onDeleted,
    onError,
  });
  const changed =
    draftName.trim() !== collection.name ||
    draftDescription.trim() !== (collection.description ?? "");

  return (
    <div data-testid="collection-detail" data-collection-name={collection.name}>
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        {editing ? (
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (changed && draftName.trim()) update.mutate();
              else setEditing(false);
            }}
          >
            <input
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              maxLength={64}
              aria-label="Name"
              className="h-7 w-44 rounded border border-border bg-bg px-2"
              data-testid="collection-edit-name"
            />
            <input
              value={draftDescription}
              onChange={(e) => setDraftDescription(e.target.value)}
              maxLength={500}
              placeholder="description"
              aria-label="Description"
              className="h-7 w-64 rounded border border-border bg-bg px-2"
              data-testid="collection-edit-description"
            />
            <Button type="submit" size="xs" variant="primary" data-testid="collection-save">
              Save
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => {
                setEditing(false);
                setDraftName(collection.name);
                setDraftDescription(collection.description ?? "");
              }}
            >
              Cancel
            </Button>
          </form>
        ) : (
          <>
            <h2 className="text-[13px] font-semibold" data-testid="collection-title">
              {collection.name}
            </h2>
            {collection.description && (
              <span className="text-fg-muted" data-testid="collection-description">
                {collection.description}
              </span>
            )}
            <span className="text-[11px] text-fg-faint" title={collection.updatedAt}>
              updated {relativeTime(collection.updatedAt)}
            </span>
          </>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Link
            href={`/?collection=${encodeURIComponent(collection.name)}`}
            className="text-[11px] text-fg-muted hover:text-fg"
            data-testid="collection-explore"
          >
            Open in explorer →
          </Link>
          <a
            href={api.collectionExportUrl(collection.id)}
            className="text-[11px] text-fg-muted hover:text-fg"
            title="Download every trace of this collection as bundles (newline-delimited JSON)"
            download
            data-testid="collection-export"
          >
            Export
          </a>
          {!editing && (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => setEditing(true)}
              data-testid="collection-edit"
            >
              Edit
            </Button>
          )}
          {confirmDelete ? (
            <>
              <Button
                size="xs"
                variant="danger"
                onClick={() => destroy.mutate()}
                data-testid="collection-delete-confirm"
              >
                Confirm delete
              </Button>
              <Button size="xs" variant="ghost" onClick={() => setConfirmDelete(false)}>
                Keep
              </Button>
            </>
          ) : (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => setConfirmDelete(true)}
              data-testid="collection-delete"
            >
              Delete
            </Button>
          )}
        </div>
      </header>
      {others.length > 0 && (
        <div className="border-b border-border px-3 py-2 text-[11px]">
          <div className="flex items-center gap-2">
            <label htmlFor="collection-compare" className="text-fg-muted">
              Compare with
            </label>
            <select
              id="collection-compare"
              value={compareWith}
              onChange={(e) => setCompareWith(e.target.value)}
              className="h-6 rounded border border-border bg-bg px-1"
              data-testid="collection-compare"
            >
              <option value="">(none)</option>
              {others.map((c) => (
                <option key={c.id} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          {other && <CollectionComparison left={collection} right={other} />}
        </div>
      )}
      {traces.isError ? (
        <ErrorState error={traces.error} retry={() => traces.refetch()} />
      ) : !traces.data ? (
        <div className="space-y-1 p-3" aria-busy="true">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-7 w-full" />
          ))}
        </div>
      ) : traces.data.items.length === 0 ? (
        <EmptyState title="No traces in this collection">
          Tick traces in the explorer and add them, or run `shadow collections add`.
        </EmptyState>
      ) : (
        <table className="w-full border-collapse" data-testid="collection-traces">
          <thead className="text-left text-[11px] uppercase tracking-wide text-fg-muted">
            <tr>
              <th className="px-3 py-1">Trace</th>
              <th className="px-3 py-1">Agent</th>
              <th className="px-3 py-1">Status</th>
              <th className="px-3 py-1">Outcome</th>
              <th className="px-3 py-1">Cost</th>
              <th className="px-3 py-1">Started</th>
              <th className="px-3 py-1" />
            </tr>
          </thead>
          <tbody>
            {traces.data.items.map((t: TraceSummary) => (
              <tr
                key={t.id}
                className="border-t border-border"
                data-testid="collection-trace"
                data-trace-id={t.id}
              >
                <td className="px-3 py-1.5">
                  <Link href={`/traces/${encodeURIComponent(t.id)}`} className="hover:underline">
                    {t.name}
                  </Link>
                </td>
                <td className="px-3 py-1.5 text-fg-muted">{t.agentSlug}</td>
                <td className="px-3 py-1.5">
                  <Badge tone={statusTone(t.status)}>{t.status}</Badge>
                </td>
                <td className="px-3 py-1.5">
                  {t.outcome ? (
                    <Badge tone={outcomeTone(t.outcome.kind)}>{t.outcome.label}</Badge>
                  ) : (
                    <span className="text-fg-faint">–</span>
                  )}
                </td>
                <td className="px-3 py-1.5 tabular">{money(t.metrics.totalEstimatedCost)}</td>
                <td className="px-3 py-1.5 text-fg-muted" title={t.startedAt}>
                  {dateTime(t.startedAt)}
                </td>
                <td className="px-3 py-1.5 text-right">
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => remove.mutate(t.id)}
                    data-testid="collection-remove-trace"
                  >
                    Remove
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {collection.traceCount > 0 && (
        <div className="grid gap-3 border-t border-border p-3 text-[12px] md:grid-cols-2">
          <section data-testid="collection-tools">
            <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
              Tools
            </h3>
            {tools.isError ? (
              <ErrorState error={tools.error} retry={() => tools.refetch()} />
            ) : !tools.data ? (
              <Skeleton className="h-12 w-full" />
            ) : tools.data.items.length === 0 ? (
              <p className="text-fg-muted">No tool calls in this collection.</p>
            ) : (
              <table className="w-full border-collapse">
                <thead className="text-left text-[11px] uppercase tracking-wide text-fg-muted">
                  <tr>
                    <th className="py-1 pr-3">Tool</th>
                    <th className="py-1 pr-3 text-right">Calls</th>
                    <th className="py-1 pr-3 text-right">Errors</th>
                    <th className="py-1 text-right">p95</th>
                  </tr>
                </thead>
                <tbody className="tabular">
                  {tools.data.items.map((t) => (
                    <tr key={t.tool} className="border-t border-border" data-tool={t.tool}>
                      <td className="py-1 pr-3 font-mono text-[11px]">{t.tool}</td>
                      <td className="py-1 pr-3 text-right">{t.calls}</td>
                      <td className={`py-1 pr-3 text-right ${t.errors > 0 ? "text-err" : ""}`}>
                        {t.errors}
                      </td>
                      <td className="py-1 text-right">{duration(t.p95DurationMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
          <section data-testid="collection-models">
            <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
              Models
            </h3>
            {models.isError ? (
              <ErrorState error={models.error} retry={() => models.refetch()} />
            ) : !models.data ? (
              <Skeleton className="h-12 w-full" />
            ) : models.data.items.length === 0 ? (
              <p className="text-fg-muted">No model calls in this collection.</p>
            ) : (
              <table className="w-full border-collapse">
                <thead className="text-left text-[11px] uppercase tracking-wide text-fg-muted">
                  <tr>
                    <th className="py-1 pr-3">Model</th>
                    <th className="py-1 pr-3 text-right">Calls</th>
                    <th className="py-1 pr-3 text-right">Tokens</th>
                    <th className="py-1 text-right">Est. cost</th>
                  </tr>
                </thead>
                <tbody className="tabular">
                  {models.data.items.map((m) => (
                    <tr
                      key={`${m.provider}:${m.model}`}
                      className="border-t border-border"
                      data-model={m.model}
                    >
                      <td className="py-1 pr-3">
                        <span className="font-mono text-[11px]">{m.model}</span>
                        <span className="ml-2 text-fg-faint">{m.provider}</span>
                      </td>
                      <td className="py-1 pr-3 text-right">{m.calls}</td>
                      <td className="py-1 pr-3 text-right">{m.totalTokens.toLocaleString()}</td>
                      <td className="py-1 text-right">{money(m.estimatedCost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
