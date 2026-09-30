"use client";

import { api } from "@/lib/api";
import type { Collection } from "@shadow/schemas";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../ui/primitives";

/** Add the ticked traces to a collection, creating the collection when the name is new. */
export function CollectionAdder({
  traceIds,
  collections,
}: {
  traceIds: string[];
  collections: Collection[];
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  const submit = async () => {
    const target = name.trim();
    if (!target || traceIds.length === 0) return;
    setBusy(true);
    setMessage(null);
    try {
      const exists = collections.some((c) => c.name === target);
      const result = exists
        ? await api.addToCollection(target, traceIds)
        : await api.createCollection(target, traceIds);
      setMessage({
        text: `${exists ? "Added to" : "Created"} ${result.collection.name} (${result.collection.traceCount} trace${result.collection.traceCount === 1 ? "" : "s"})`,
        error: false,
      });
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
        void submit();
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
