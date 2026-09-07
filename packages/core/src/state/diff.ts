import type { DiffEntry, JsonValue } from "@shadow/schemas";
import { deepEqual } from "../json.js";
import { escapeSegment } from "./pointer.js";

/**
 * Leaf-level structural diff of two JSON values. Only meaningful differences
 * are reported: identical subtrees are skipped entirely.
 */
export function diffJson(
  before: JsonValue | undefined,
  after: JsonValue | undefined,
  basePath = "",
): DiffEntry[] {
  const entries: DiffEntry[] = [];
  walk(before, after, basePath, entries);
  return entries;
}

function walk(
  before: JsonValue | undefined,
  after: JsonValue | undefined,
  path: string,
  out: DiffEntry[],
): void {
  if (deepEqual(before, after)) return;
  if (before === undefined) {
    out.push({ path, op: "added", after });
    return;
  }
  if (after === undefined) {
    out.push({ path, op: "removed", before });
    return;
  }
  const bothObjects =
    before !== null &&
    after !== null &&
    typeof before === "object" &&
    typeof after === "object" &&
    Array.isArray(before) === Array.isArray(after);
  if (!bothObjects) {
    out.push({ path, op: "changed", before, after });
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const max = Math.max(before.length, after.length);
    for (let i = 0; i < max; i++) {
      walk(before[i], after[i], `${path}/${i}`, out);
    }
    return;
  }
  const b = before as Record<string, JsonValue>;
  const a = after as Record<string, JsonValue>;
  const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
  for (const key of [...keys].sort()) {
    walk(b[key], a[key], `${path}/${escapeSegment(key)}`, out);
  }
}

/** Human-readable rendering of a diff entry path (`/a/b` → `a.b`). */
export function formatDiffPath(path: string): string {
  if (path === "") return "(root)";
  return path
    .slice(1)
    .split("/")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"))
    .join(".");
}
