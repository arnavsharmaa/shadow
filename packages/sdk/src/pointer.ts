import type { JsonObject, JsonValue } from "@shadow/schemas";

/** Minimal RFC 6901 helpers (kept local so the SDK has no engine dependency). */
export function parsePointer(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) throw new Error(`Invalid JSON pointer: ${pointer}`);
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

export function getAtPointer(doc: JsonValue, pointer: string): JsonValue | undefined {
  let current: JsonValue | undefined = doc;
  for (const segment of parsePointer(pointer)) {
    if (current === null || typeof current !== "object") return undefined;
    current = Array.isArray(current)
      ? current[Number.parseInt(segment, 10)]
      : (current as JsonObject)[segment];
  }
  return current;
}

export function setAtPointer(doc: JsonValue, pointer: string, value: JsonValue): JsonValue {
  const segments = parsePointer(pointer);
  if (segments.length === 0) return value;
  const [head, ...rest] = segments as [string, ...string[]];
  if (Array.isArray(doc)) {
    const copy = doc.slice();
    const index = head === "-" ? copy.length : Number.parseInt(head, 10);
    copy[index] =
      rest.length === 0 ? value : setAtPointer(copy[index] ?? {}, `/${rest.join("/")}`, value);
    return copy;
  }
  const base: JsonObject = doc !== null && typeof doc === "object" ? { ...doc } : {};
  base[head] =
    rest.length === 0
      ? value
      : setAtPointer(base[head] ?? {}, `/${rest.map(escape).join("/")}`, value);
  return base;
}

export function removeAtPointer(doc: JsonValue, pointer: string): JsonValue {
  const segments = parsePointer(pointer);
  if (segments.length === 0) return {};
  const [head, ...rest] = segments as [string, ...string[]];
  if (doc === null || typeof doc !== "object") return doc;
  if (Array.isArray(doc)) {
    const index = Number.parseInt(head, 10);
    const copy = doc.slice();
    if (rest.length === 0) copy.splice(index, 1);
    else copy[index] = removeAtPointer(copy[index] as JsonValue, `/${rest.map(escape).join("/")}`);
    return copy;
  }
  if (!(head in doc)) return doc;
  const copy: JsonObject = { ...doc };
  if (rest.length === 0) delete copy[head];
  else copy[head] = removeAtPointer(copy[head] as JsonValue, `/${rest.map(escape).join("/")}`);
  return copy;
}

function escape(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

export function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Convert to plain JSON, dropping undefined and rejecting non-JSON values. */
export function toJson(value: unknown): JsonValue {
  if (value === undefined) return null;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("value is not JSON serialisable");
  return JSON.parse(encoded) as JsonValue;
}
