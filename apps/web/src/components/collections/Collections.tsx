"use client";

import { api } from "@/lib/api";
import { classNames, dateTime, money, relativeTime } from "@/lib/format";
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
                    <span className="shrink-0 text-[11px] text-fg-muted">
                      {c.traceCount} trace{c.traceCount === 1 ? "" : "s"}
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

function CollectionDetail({
  collection,
  onChanged,
  onDeleted,
  onError,
}: {
  collection: Collection;
  onChanged: () => void;
  onDeleted: () => void;
  onError: (error: unknown) => void;
}) {
  const queryClient = useQueryClient();
  const traces = useQuery({
    queryKey: ["collection-traces", collection.name],
    queryFn: () => api.listTraces({ collection: collection.name, limit: 100 }),
  });
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(collection.name);
  const [draftDescription, setDraftDescription] = useState(collection.description ?? "");
  const [confirmDelete, setConfirmDelete] = useState(false);
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
    </div>
  );
}
