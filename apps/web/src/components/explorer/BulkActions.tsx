"use client";

import { api } from "@/lib/api";
import type { TraceSummary } from "@shadow/schemas";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../ui/primitives";

/** Tag or delete the ticked traces in one go; each trace is its own API call. */
export function BulkActions({
  traces,
  onDone,
}: {
  traces: TraceSummary[];
  /** Called after a change, with the ids that are now gone and a line describing what happened. */
  onDone: (removed: string[], notice: string) => void;
}) {
  const queryClient = useQueryClient();
  const [tag, setTag] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["traces"] });
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
      </form>
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
