"use client";

import { api } from "@/lib/api";
import {
  deleteView,
  noViews,
  saveView,
  subscribeViews,
  viewQuery,
  viewsSnapshot,
} from "@/lib/views";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, useSyncExternalStore } from "react";
import { Button } from "../ui/primitives";

interface Choice {
  /** `shared:<viewId>` or `local:<name>`. */
  key: string;
  name: string;
  query: string;
  shared: boolean;
  id?: string;
}

/**
 * Save the current filters under a name and re-apply saved sets later. Views are either
 * shared (stored by the API, visible to everyone using it) or kept in this browser.
 */
export function SavedViews() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const queryClient = useQueryClient();
  // Browser views live in localStorage; the store notifies on changes here and in other tabs.
  const local = useSyncExternalStore(subscribeViews, viewsSnapshot, noViews);
  // Shared views come from the API; an older API without /views simply shows none.
  const shared = useQuery({ queryKey: ["views"], queryFn: api.views, retry: false });
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [share, setShare] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = viewQuery(params);

  const sharedChoices: Choice[] = (shared.data?.items ?? []).map((v) => ({
    key: `shared:${v.id}`,
    name: v.name,
    query: v.query,
    shared: true,
    id: v.id,
  }));
  const localChoices: Choice[] = local.map((v) => ({
    key: `local:${v.name}`,
    name: v.name,
    query: v.query,
    shared: false,
  }));
  const choices = [...sharedChoices, ...localChoices];
  const active = choices.find((c) => c.query === current);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["views"] });
  const saveShared = useMutation({
    mutationFn: (input: { name: string; query: string }) => api.saveView(input),
    onSuccess: refresh,
  });
  const removeShared = useMutation({
    mutationFn: (viewId: string) => api.deleteView(viewId),
    onSuccess: refresh,
  });

  const apply = (key: string) => {
    const choice = choices.find((c) => c.key === key);
    if (!choice) return;
    router.replace(choice.query ? `${pathname}?${choice.query}` : pathname);
  };

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setError(null);
    if (share) {
      try {
        await saveShared.mutateAsync({ name: trimmed, query: current });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return;
      }
    } else {
      saveView(trimmed, current);
    }
    setName("");
    setShare(false);
    setNaming(false);
  };

  const remove = async (choice: Choice) => {
    setError(null);
    if (choice.shared && choice.id) {
      try {
        await removeShared.mutateAsync(choice.id);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } else {
      deleteView(choice.name);
    }
  };

  return (
    <div className="flex items-center gap-1" data-testid="saved-views">
      {choices.length > 0 && (
        <select
          value={active?.key ?? ""}
          onChange={(e) => apply(e.target.value)}
          aria-label="Saved views"
          className="h-7 rounded border border-border bg-bg px-1 text-[12px] text-fg"
          data-testid="saved-view-select"
        >
          <option value="">Saved views…</option>
          {sharedChoices.length > 0 && (
            <optgroup label="Shared with the team">
              {sharedChoices.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.name}
                </option>
              ))}
            </optgroup>
          )}
          {localChoices.length > 0 && (
            <optgroup label="This browser">
              {localChoices.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.name}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      )}
      {active?.shared && (
        <span
          className="rounded border border-border px-1 text-[10px] uppercase tracking-wide text-fg-muted"
          data-testid="shared-view-badge"
        >
          shared
        </span>
      )}
      {active && (
        <Button
          variant="ghost"
          size="xs"
          aria-label={`Delete view ${active.name}`}
          title={
            active.shared
              ? `Delete shared view ${active.name} for everyone`
              : `Delete view ${active.name}`
          }
          onClick={() => void remove(active)}
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
            void save();
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
          <label className="flex items-center gap-1 text-[11px] text-fg-muted">
            <input
              type="checkbox"
              checked={share}
              onChange={(e) => setShare(e.target.checked)}
              data-testid="share-view"
            />
            Share with team
          </label>
          <Button
            type="submit"
            size="xs"
            variant="primary"
            disabled={!name.trim() || saveShared.isPending}
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
      {error && (
        <span className="text-[11px] text-err" role="alert" data-testid="view-error">
          {error}
        </span>
      )}
    </div>
  );
}
