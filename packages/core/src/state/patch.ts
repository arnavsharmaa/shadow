import type { JsonObject, JsonValue, PatchOperation } from "@shadow/schemas";
import { deepEqual } from "../json.js";
import { escapeSegment, removeAtPointer, setAtPointer } from "./pointer.js";

/** Apply RFC 6902 operations (add/replace/remove) immutably. */
export function applyPatch(doc: JsonValue, ops: readonly PatchOperation[]): JsonValue {
  let current = doc;
  for (const op of ops) {
    switch (op.op) {
      case "add":
      case "replace":
        current = setAtPointer(current, op.path, op.value);
        break;
      case "remove":
        current = removeAtPointer(current, op.path);
        break;
      default: {
        const never: never = op;
        throw new Error(`Unsupported patch operation ${JSON.stringify(never)}`);
      }
    }
  }
  return current;
}

/**
 * Produce a minimal-ish patch that transforms `before` into `after`.
 * Objects are diffed recursively; arrays and primitives are replaced whole.
 */
export function createPatch(before: JsonObject, after: JsonObject): PatchOperation[] {
  const ops: PatchOperation[] = [];
  diffInto(before, after, "", ops);
  return ops;
}

function diffInto(before: JsonValue, after: JsonValue, path: string, ops: PatchOperation[]): void {
  if (deepEqual(before, after)) return;
  const bothObjects =
    before !== null &&
    after !== null &&
    typeof before === "object" &&
    typeof after === "object" &&
    !Array.isArray(before) &&
    !Array.isArray(after);
  if (!bothObjects) {
    ops.push({ op: path === "" || before === undefined ? "add" : "replace", path, value: after });
    return;
  }
  const b = before as JsonObject;
  const a = after as JsonObject;
  for (const key of Object.keys(b)) {
    if (!(key in a)) ops.push({ op: "remove", path: `${path}/${escapeSegment(key)}` });
  }
  for (const key of Object.keys(a)) {
    const childPath = `${path}/${escapeSegment(key)}`;
    if (!(key in b)) ops.push({ op: "add", path: childPath, value: a[key] as JsonValue });
    else diffInto(b[key] as JsonValue, a[key] as JsonValue, childPath, ops);
  }
}
