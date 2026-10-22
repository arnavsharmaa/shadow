"use client";

import { api, apiBaseUrl } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import type { TraceShare } from "@shadow/schemas";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Badge, Button, Dialog, EmptyState, ErrorState, Skeleton } from "../ui/primitives";

const LIFETIMES: { hours: number; label: string }[] = [
  { hours: 1, label: "1 hour" },
  { hours: 24, label: "1 day" },
  { hours: 24 * 7, label: "7 days" },
  { hours: 24 * 30, label: "30 days" },
];

interface Props {
  traceId: string;
  open: boolean;
  onClose: () => void;
}

function shareState(share: TraceShare, now: number): "active" | "expired" | "revoked" {
  if (share.revokedAt) return "revoked";
  return Date.parse(share.expiresAt) <= now ? "expired" : "active";
}

/**
 * Read-only share links for one trace: create one (the token is shown once, here), copy the
 * viewer or bundle URL, and revoke links that are no longer needed.
 */
export function ShareDialog({ traceId, open, onClose }: Props) {
  const queryClient = useQueryClient();
  const shares = useQuery({
    queryKey: ["shares", traceId],
    queryFn: () => api.shares(traceId),
    enabled: open,
  });
  const [hours, setHours] = useState(24 * 7);
  const [note, setNote] = useState("");
  const [created, setCreated] = useState<{ token: string; path: string; share: TraceShare } | null>(
    null,
  );
  const [copied, setCopied] = useState<"viewer" | "bundle" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now] = useState(() => Date.now());

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["shares", traceId] });
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  const create = useMutation({
    mutationFn: () =>
      api.createShare(traceId, {
        expiresInHours: hours,
        ...(note.trim() ? { note: note.trim() } : {}),
      }),
    onSuccess: async (result) => {
      setCreated(result);
      setNote("");
      setError(null);
      setCopied(null);
      await refresh();
    },
    onError: fail,
  });
  const revoke = useMutation({
    mutationFn: (share: TraceShare) => api.revokeShare(traceId, share.id),
    onSuccess: async (_result, share) => {
      if (created?.share.id === share.id) setCreated(null);
      await refresh();
    },
    onError: fail,
  });

  const viewerUrl = created
    ? `${typeof window === "undefined" ? "" : window.location.origin}/shared/${created.token}`
    : "";
  const bundleUrl = created ? `${apiBaseUrl()}${created.path}` : "";
  const copy = async (what: "viewer" | "bundle", text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
    } catch {
      setCopied(null);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={() => {
        setCreated(null);
        setError(null);
        onClose();
      }}
      title="Share this trace"
      width="max-w-3xl"
      testId="share-dialog"
    >
      <form
        className="flex flex-wrap items-end gap-2 border-b border-border px-4 py-3 text-[12px]"
        onSubmit={(e) => {
          e.preventDefault();
          if (!create.isPending) create.mutate();
        }}
      >
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-fg-muted">Expires in</span>
          <select
            value={hours}
            onChange={(e) => setHours(Number(e.target.value))}
            className="h-7 rounded border border-border bg-bg px-1"
            data-testid="share-expires"
          >
            {LIFETIMES.map((l) => (
              <option key={l.hours} value={l.hours}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-[11px] text-fg-muted">Note (who it is for)</span>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            placeholder="vendor review"
            className="h-7 w-full rounded border border-border bg-bg px-2"
            data-testid="share-note"
          />
        </label>
        <Button
          type="submit"
          variant="primary"
          disabled={create.isPending}
          data-testid="create-share"
        >
          Create link
        </Button>
        <span className="basis-full text-[11px] text-fg-faint">
          Anyone with the link can read the whole trace, without the API token, until it expires or
          is revoked. The link is shown once.
        </span>
      </form>
      {error && (
        <div
          className="border-b border-err/40 bg-err-bg px-4 py-1.5 text-[12px] text-err"
          role="alert"
        >
          {error}
        </div>
      )}
      {created && (
        <div
          className="space-y-2 border-b border-border bg-panel px-4 py-3 text-[12px]"
          data-testid="share-created"
        >
          <div className="font-medium">
            Link created{created.share.note ? ` for ${created.share.note}` : ""}, expires{" "}
            {relativeTime(created.share.expiresAt)}.
          </div>
          <div className="flex items-center gap-2">
            <span className="w-16 shrink-0 text-fg-muted">Viewer</span>
            <code className="truncate" data-testid="share-viewer-link">
              {viewerUrl}
            </code>
            <Button size="xs" onClick={() => void copy("viewer", viewerUrl)}>
              {copied === "viewer" ? "Copied" : "Copy"}
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-16 shrink-0 text-fg-muted">Bundle</span>
            <code className="truncate" data-testid="share-bundle-link">
              {bundleUrl}
            </code>
            <Button size="xs" onClick={() => void copy("bundle", bundleUrl)}>
              {copied === "bundle" ? "Copied" : "Copy"}
            </Button>
          </div>
          <div className="text-[11px] text-fg-faint">
            Import it elsewhere with <code>shadow traces import {bundleUrl}</code>.
          </div>
        </div>
      )}
      {shares.isError ? (
        <ErrorState error={shares.error} retry={() => shares.refetch()} />
      ) : !shares.data ? (
        <div className="space-y-1 p-3" aria-busy="true">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-7 w-full" />
          ))}
        </div>
      ) : shares.data.items.length === 0 ? (
        <EmptyState title="No share links yet">
          Create one above or with `shadow traces share`. Tokens are never shown again after
          creation.
        </EmptyState>
      ) : (
        <table className="w-full border-collapse text-[12px]" data-testid="share-table">
          <thead className="text-left text-[11px] uppercase tracking-wide text-fg-muted">
            <tr>
              <th className="px-4 py-1">Link</th>
              <th className="px-3 py-1">State</th>
              <th className="px-3 py-1">Expires</th>
              <th className="px-3 py-1">Opened</th>
              <th className="px-3 py-1">Note</th>
              <th className="px-3 py-1" />
            </tr>
          </thead>
          <tbody>
            {shares.data.items.map((share) => {
              const state = shareState(share, now);
              return (
                <tr
                  key={share.id}
                  className="border-t border-border"
                  data-testid="share-row"
                  data-share-id={share.id}
                >
                  <td className="px-4 py-1.5 font-mono text-[11px]">{share.id}</td>
                  <td className="px-3 py-1.5" data-testid="share-state">
                    <Badge tone={state === "active" ? "ok" : "muted"}>{state}</Badge>
                  </td>
                  <td className="px-3 py-1.5" title={share.expiresAt}>
                    {relativeTime(share.expiresAt)}
                  </td>
                  <td className="px-3 py-1.5">
                    {share.accessCount}×
                    {share.lastAccessedAt ? (
                      <span className="text-fg-faint">
                        {" "}
                        · last {relativeTime(share.lastAccessedAt)}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-1.5">{share.note ?? ""}</td>
                  <td className="px-3 py-1.5 text-right whitespace-nowrap">
                    {state === "active" && (
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={revoke.isPending}
                        onClick={() => revoke.mutate(share)}
                        data-testid="revoke-share"
                      >
                        Revoke
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Dialog>
  );
}
