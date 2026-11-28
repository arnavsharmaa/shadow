"use client";

import { api } from "@/lib/api";
import { countBundles, EXPORT_FILENAME, exportHint, exportNotice, saveText } from "@/lib/export";
import type { TraceSelection } from "@shadow/schemas";
import { useState } from "react";

/**
 * Downloads every trace the explorer's filters match as bundles, one per line: the whole
 * selection in one file (the API stops at its cap), without ticking rows page by page.
 */
export function ExportMatching({ query, total }: { query: TraceSelection; total: number }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  const run = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const text = await api.exportTracesNdjson({ query });
      const count = countBundles(text);
      if (count > 0) saveText(text, EXPORT_FILENAME, "application/x-ndjson");
      setMessage({ text: exportNotice(count, total), error: false });
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : String(e), error: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className="inline-flex h-6 items-center rounded border border-border px-2 text-[11px] text-fg-muted hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
        disabled={busy || total === 0}
        onClick={() => void run()}
        title={exportHint(total)}
        data-testid="traces-export-matching"
      >
        {busy ? "Exporting…" : "Export bundles"}
      </button>
      {message && (
        <span
          className={message.error ? "text-[11px] text-err" : "text-[11px] text-fg-muted"}
          role="status"
          data-testid="traces-export-message"
        >
          {message.text}
        </span>
      )}
    </>
  );
}
