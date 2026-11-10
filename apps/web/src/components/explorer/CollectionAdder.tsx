"use client";

import { api } from "@/lib/api";
import type { Collection, TraceSelection } from "@shadow/schemas";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../ui/primitives";

/** The newest traces the API adds for one selection. */
const SELECTION_LIMIT = 500;

/**
 * Add the ticked traces to a collection, creating the collection when the name is new; with a
 * `matching` selection, every trace the current filters match can be added instead.
 */
export function CollectionAdder({
  traceIds,
  collections,
  matching,
}: {
  traceIds: string[];
  collections: Collection[];
  /** The explorer's current filters and how many traces they match. */
  matching?: { query: TraceSelection; total: number };
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  const submit = async (mode: "picked" | "matching") => {
    const target = name.trim();
    if (!target) return;
    if (mode === "picked" && traceIds.length === 0) return;
    if (mode === "matching" && !matching) return;
    setBusy(true);
    setMessage(null);
    try {
      const exists = collections.some((c) => c.name === target);
      const plural = (n: number) => `${n} trace${n === 1 ? "" : "s"}`;
      if (mode === "matching" && matching) {
        if (!exists) await api.createCollection(target, []);
        const result = await api.addToCollection(target, [], matching.query);
        setMessage({
          text: `Added ${plural(result.matched)} matching the filters to ${result.collection.name} (now ${plural(result.collection.traceCount)})`,
          error: false,
        });
      } else {
        const result = exists
          ? await api.addToCollection(target, traceIds)
          : await api.createCollection(target, traceIds);
        setMessage({
          text: `${exists ? "Added to" : "Created"} ${result.collection.name} (${plural(result.collection.traceCount)})`,
          error: false,
        });
      }
      setName("");
      await queryClient.invalidateQueries({ queryKey: ["collections"] });
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : String(e), error: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        void submit("picked");
      }}
    >
      <label htmlFor="collection-name" className="text-fg-muted">
        Collection
      </label>
      <input
        id="collection-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        list="collection-names"
        placeholder="incident-42"
        maxLength={64}
        className="h-6 w-40 rounded border border-border bg-bg px-2 text-[12px] placeholder:text-fg-faint"
        data-testid="collection-name"
      />
      <datalist id="collection-names">
        {collections.map((c) => (
          <option key={c.id} value={c.name} />
        ))}
      </datalist>
      <Button
        type="submit"
        size="xs"
        disabled={busy || !name.trim()}
        data-testid="add-to-collection"
      >
        Add to collection
      </Button>
      {matching && matching.total > 0 && (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={busy || !name.trim()}
          onClick={() => void submit("matching")}
          title={
            matching.total > SELECTION_LIMIT
              ? `Adds the newest ${SELECTION_LIMIT} of the ${matching.total.toLocaleString()} traces the current filters match`
              : "Adds every trace the current filters match, not only the ticked ones"
          }
          data-testid="add-matching-to-collection"
        >
          Add all {Math.min(matching.total, SELECTION_LIMIT).toLocaleString()} matching
        </Button>
      )}
      {message && (
        <span
          className={message.error ? "text-err" : "text-fg-muted"}
          role={message.error ? "alert" : "status"}
          data-testid="collection-message"
        >
          {message.text}
        </span>
      )}
    </form>
  );
}
