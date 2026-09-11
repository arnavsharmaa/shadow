"use client";

import { useState, type KeyboardEvent } from "react";

interface Props {
  tags: string[];
  /** Persist a change; resolves once the server accepted it. */
  onChange: (change: { addTags?: string[]; removeTags?: string[] }) => Promise<void>;
}

/** Inline tag chips with add/remove; used in the trace header. */
export function TagEditor({ tags, onChange }: Props) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = async (change: { addTags?: string[]; removeTags?: string[] }) => {
    setBusy(true);
    setError(null);
    try {
      await onChange(change);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    const values = draft
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0 && !tags.includes(t));
    setDraft("");
    if (values.length === 0) return;
    await apply({ addTags: values });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void add();
    } else if (e.key === "Backspace" && draft === "" && tags.length > 0) {
      const last = tags[tags.length - 1];
      if (last) void apply({ removeTags: [last] });
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-1" data-testid="tag-editor">
      {tags.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-0.5 rounded border border-border bg-bg px-1.5 text-[11px] leading-4"
          data-testid="trace-tag"
          data-tag={tag}
        >
          {tag}
          <button
            type="button"
            aria-label={`Remove tag ${tag}`}
            title={`Remove tag ${tag}`}
            disabled={busy}
            onClick={() => void apply({ removeTags: [tag] })}
            className="ml-0.5 rounded px-0.5 text-fg-faint hover:bg-hover hover:text-fg disabled:opacity-50"
          >
            ×
          </button>
        </span>
      ))}
      <input
        aria-label="Add tag"
        placeholder={tags.length === 0 ? "add tag" : "+ tag"}
        value={draft}
        disabled={busy}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => void add()}
        maxLength={64}
        className="h-5 w-16 min-w-0 rounded border border-transparent bg-transparent px-1 text-[11px] placeholder:text-fg-faint focus:w-32 focus:border-border focus:bg-bg focus:outline-none"
        data-testid="tag-input"
      />
      {error && (
        <span className="text-[11px] text-err" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
