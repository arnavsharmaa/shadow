import type { JsonObject, JsonValue } from "@shadow/schemas";
import { isJsonObject } from "@shadow/schemas";

export function deepClone<T extends JsonValue | undefined>(value: T): T {
  if (value === undefined || value === null || typeof value !== "object") return value;
  return structuredClone(value);
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  if (typeof a === "object" && typeof b === "object") {
    const ak = Object.keys(a as object);
    const bk = Object.keys(b as object);
    if (ak.length !== bk.length) return false;
    for (const key of ak) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
      if (!deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) {
        return false;
      }
    }
    return true;
  }
  return false;
}

/** Stable JSON serialisation with sorted keys (for hashing/fingerprints). */
export function stableStringify(value: JsonValue | undefined): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k] as JsonValue)}`).join(",")}}`;
}

/** Ensure a value is JSON (drops undefined, rejects functions/NaN). */
export function toJson(value: unknown): JsonValue {
  if (value === undefined) return null;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new TypeError("value is not JSON serialisable");
  }
  return JSON.parse(encoded) as JsonValue;
}

export function asJsonObject(value: unknown): JsonObject {
  return isJsonObject(value) ? value : {};
}

export { isJsonObject };
