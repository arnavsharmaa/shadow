"use client";

import { api } from "@/lib/api";
import type { TraceSelection, TraceSummary } from "@shadow/schemas";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../ui/primitives";

/** The newest traces the API tags for one selection. */
const SELECTION_LIMIT = 500;

/**
 * Tag or delete the ticked traces in one go; each trace is its own API call. With a `matching`
 * selection, a tag can also go on every trace the current filters match, in one call.
 */
export function BulkActions({
  traces,
  onDone,
  matching,
}: {
  traces: TraceSummary[];
  /** Called after a change, with the ids that are now gone and a line describing what happened. */
  onDone: (removed: string[], notice: string) => void;
  /** The explorer's current filters and how many traces they match. */
  matching?: { query: TraceSelection; total: number };
}) {
  const queryClient = useQueryClient();
  const [tag, setTag] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["traces"] });
    // Deleting or tagging changes what the filters match, and with it the totals strip.
    await queryClient.invalidateQueries({ queryKey: ["trace-totals"] });
  };
  const exportAll = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const text = await api.exportTracesNdjson(traces.map((t) => t.id));
      const blob = new Blob([text], { type: "application/x-ndjson" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "shadow-traces.shadow.ndjson";
      anchor.click();
      URL.revokeObjectURL(url);
      const count = text.split("\n").filter((l) => l.length > 0).length;
      setMessage({ text: `Exported ${count} trace${count === 1 ? "" : "s"}`, error: false });
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : String(e), error: true });
    } finally {
      setBusy(false);
    }
  };
  const tagMatching = async () => {
    const value = tag.trim();
    if (!value || !matching) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await api.tagTraces({ query: matching.query, add: [value] });
      await refresh();
      const count = result.updated.length;
      const text = `Tagged ${count} trace${count === 1 ? "" : "s"} matching the filters`;
      setMessage({ text, error: false });
      setTag("");
      onDone([], text);
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : String(e), error: true });
    } finally {
      setBusy(false);
    }
  };
  const run = async (
    label: string,
    action: (trace: TraceSummary) => Promise<unknown>,
    removes: boolean,
  ) => {
    setBusy(true);
    setMessage(null);
    const done: string[] = [];
    const failed: string[] = [];
    for (const trace of traces) {
      try {
        await action(trace);
        done.push(trace.id);
      } catch {
        failed.push(trace.id);
      }
    }
    await refresh();
    const text = `${label} ${done.length} trace${done.length === 1 ? "" : "s"}${failed.length > 0 ? `; ${failed.length} failed` : ""}`;
    setMessage({ text, error: failed.length > 0 });
    setBusy(false);
    setConfirming(false);
    onDone(removes ? done : [], text);
  };

  return (
    <div className="flex items-center gap-2" data-testid="bulk-actions">
      <form
        className="flex items-center gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          const value = tag.trim();
          if (!value) return;
          void run("Tagged", (t) => api.updateTrace(t.id, { addTags: [value] }), false).then(() =>
            setTag(""),
          );
        }}
      >
        <label htmlFor="bulk-tag" className="text-fg-muted">
          Tag
        </label>
        <input
          id="bulk-tag"
          value={tag}
          onChange={(e) => setTag(e.target.value)}
          placeholder="reviewed"
          maxLength={64}
          className="h-6 w-28 rounded border border-border bg-bg px-2 text-[12px] placeholder:text-fg-faint"
          data-testid="bulk-tag"
        />
        <Button type="submit" size="xs" disabled={busy || !tag.trim()} data-testid="bulk-add-tag">
          Add tag
        </Button>
        {matching && matching.total > 0 && (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={busy || !tag.trim()}
            onClick={() => void tagMatching()}
            title={
              matching.total > SELECTION_LIMIT
                ? `Tags the newest ${SELECTION_LIMIT} of the ${matching.total.toLocaleString()} traces the current filters match`
                : "Tags every trace the current filters match, not only the ticked ones"
            }
            data-testid="bulk-tag-matching"
          >
            Tag all {Math.min(matching.total, SELECTION_LIMIT).toLocaleString()} matching
          </Button>
        )}
      </form>
      <Button
        size="xs"
        variant="ghost"
        disabled={busy}
        onClick={() => void exportAll()}
        title="Download the ticked traces as bundles (one per line), ready for shadow traces import"
        data-testid="bulk-export"
      >
        Export
      </Button>
      {confirming ? (
        <>
          <Button
            size="xs"
            variant="danger"
            disabled={busy}
            onClick={() => void run("Deleted", (t) => api.deleteTrace(t.id), true)}
            data-testid="bulk-delete-confirm"
          >
            Delete {traces.length} trace{traces.length === 1 ? "" : "s"} for good
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setConfirming(false)}>
            Keep
          </Button>
        </>
      ) : (
        <Button
          size="xs"
          variant="ghost"
          disabled={busy}
          onClick={() => setConfirming(true)}
          data-testid="bulk-delete"
        >
          Delete
        </Button>
      )}
      {message && (
        <span
          className={message.error ? "text-err" : "text-fg-muted"}
          role="status"
          data-testid="bulk-message"
        >
          {message.text}
        </span>
      )}
    </div>
  );
}
