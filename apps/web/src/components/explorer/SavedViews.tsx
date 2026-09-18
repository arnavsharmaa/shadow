"use client";

import {
  deleteView,
  noViews,
  saveView,
  subscribeViews,
  viewQuery,
  viewsSnapshot,
} from "@/lib/views";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, useSyncExternalStore } from "react";
import { Button } from "../ui/primitives";

/** Save the current filters under a name and re-apply saved sets later. */
export function SavedViews() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  // Views live in localStorage; the store notifies on changes here and in other tabs.
  const views = useSyncExternalStore(subscribeViews, viewsSnapshot, noViews);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const current = viewQuery(params);
  const active = views.find((v) => v.query === current)?.name ?? "";

  const apply = (viewName: string) => {
    const view = views.find((v) => v.name === viewName);
    if (!view) return;
    router.replace(view.query ? `${pathname}?${view.query}` : pathname);
  };

  const save = () => {
    if (!name.trim()) return;
    saveView(name, current);
    setName("");
    setNaming(false);
  };

  return (
    <div className="flex items-center gap-1" data-testid="saved-views">
      {views.length > 0 && (
        <select
          value={active}
          onChange={(e) => apply(e.target.value)}
          aria-label="Saved views"
          className="h-7 rounded border border-border bg-bg px-1 text-[12px] text-fg"
          data-testid="saved-view-select"
        >
          <option value="">Saved views…</option>
          {views.map((v) => (
            <option key={v.name} value={v.name}>
              {v.name}
            </option>
          ))}
        </select>
      )}
      {active && (
        <Button
          variant="ghost"
          size="xs"
          aria-label={`Delete view ${active}`}
          title={`Delete view ${active}`}
          onClick={() => deleteView(active)}
          data-testid="delete-view"
        >
          ×
        </Button>
      )}
      {naming ? (
        <form
          className="flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setNaming(false);
            }}
            placeholder="View name"
            aria-label="View name"
            maxLength={64}
            className="h-7 w-36 rounded border border-border bg-bg px-2 text-[12px] placeholder:text-fg-faint"
            data-testid="view-name"
          />
          <Button
            type="submit"
            size="xs"
            variant="primary"
            disabled={!name.trim()}
            data-testid="confirm-save-view"
          >
            Save
          </Button>
          <Button type="button" size="xs" variant="ghost" onClick={() => setNaming(false)}>
            Cancel
          </Button>
        </form>
      ) : (
        <Button
          size="xs"
          onClick={() => setNaming(true)}
          title="Save the current filters and sort as a named view"
          data-testid="save-view"
        >
          Save view
        </Button>
      )}
    </div>
  );
}
