/** Named explorer filter sets, kept per browser in localStorage. */
export interface SavedView {
  name: string;
  /** URL query string (without the leading `?`), excluding pagination. */
  query: string;
  createdAt: string;
}

const KEY = "shadow-saved-views";

export function loadViews(): SavedView[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (v): v is SavedView =>
        typeof v === "object" &&
        v !== null &&
        typeof (v as SavedView).name === "string" &&
        typeof (v as SavedView).query === "string",
    );
  } catch {
    return [];
  }
}

const listeners = new Set<() => void>();
let cache: SavedView[] | null = null;
const EMPTY: SavedView[] = [];

function persist(views: SavedView[]): void {
  cache = views;
  try {
    localStorage.setItem(KEY, JSON.stringify(views));
  } catch {
    // Storage may be unavailable (private mode, quota); views then live for the session only.
  }
  for (const listener of listeners) listener();
}

/** Current views; the same array is returned until something changes (for useSyncExternalStore). */
export function viewsSnapshot(): SavedView[] {
  if (cache === null) cache = loadViews();
  return cache;
}

/** Server snapshot: no storage during SSR, so no views. */
export function noViews(): SavedView[] {
  return EMPTY;
}

/** Subscribe to view changes from this tab and from other tabs (`storage` events). */
export function subscribeViews(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY || e.key === null) {
      cache = loadViews();
      listener();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** Add or replace a view by name; returns the new list sorted by name. */
export function saveView(name: string, query: string): SavedView[] {
  const trimmed = name.trim();
  const views = viewsSnapshot().filter((v) => v.name !== trimmed);
  views.push({ name: trimmed, query, createdAt: new Date().toISOString() });
  views.sort((a, b) => a.name.localeCompare(b.name));
  persist(views);
  return views;
}

export function deleteView(name: string): SavedView[] {
  const views = viewsSnapshot().filter((v) => v.name !== name);
  persist(views);
  return views;
}

/** The part of the explorer URL worth saving: every filter, no cursor. */
export function viewQuery(params: URLSearchParams): string {
  const next = new URLSearchParams(params.toString());
  next.delete("cursor");
  next.sort();
  return next.toString();
}
