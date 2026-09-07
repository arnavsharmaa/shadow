import type { JsonObject, JsonValue } from "@shadow/schemas";

/** RFC 6901 JSON Pointer helpers. Paths are `/a/b/0`; "" is the document. */
export function parsePointer(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) throw new Error(`Invalid JSON pointer: ${pointer}`);
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

export function escapeSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

export function joinPointer(segments: string[]): string {
  return segments.length === 0 ? "" : `/${segments.map(escapeSegment).join("/")}`;
}

export function getAtPointer(doc: JsonValue, pointer: string): JsonValue | undefined {
  let current: JsonValue | undefined = doc;
  for (const segment of parsePointer(pointer)) {
    if (current === null || typeof current !== "object") return undefined;
    if (Array.isArray(current)) {
      const index = Number.parseInt(segment, 10);
      if (Number.isNaN(index)) return undefined;
      current = current[index];
    } else {
      current = (current as JsonObject)[segment];
    }
  }
  return current;
}

/** Returns a new document with `value` at `pointer` (immutable). */
export function setAtPointer(doc: JsonValue, pointer: string, value: JsonValue): JsonValue {
  const segments = parsePointer(pointer);
  if (segments.length === 0) return value;
  return setSegments(doc, segments, value);
}

function setSegments(doc: JsonValue, segments: string[], value: JsonValue): JsonValue {
  const [head, ...rest] = segments as [string, ...string[]];
  if (Array.isArray(doc)) {
    const copy = doc.slice();
    const index = head === "-" ? copy.length : Number.parseInt(head, 10);
    if (Number.isNaN(index) || index < 0 || index > copy.length) {
      throw new Error(`Invalid array index '${head}'`);
    }
    copy[index] = rest.length === 0 ? value : setSegments(copy[index] ?? {}, rest, value);
    return copy;
  }
  const base: JsonObject = doc !== null && typeof doc === "object" ? { ...doc } : {};
  base[head] = rest.length === 0 ? value : setSegments(base[head] ?? {}, rest, value);
  return base;
}

/** Returns a new document without the value at `pointer` (immutable). */
export function removeAtPointer(doc: JsonValue, pointer: string): JsonValue {
  const segments = parsePointer(pointer);
  if (segments.length === 0) return {};
  return removeSegments(doc, segments);
}

function removeSegments(doc: JsonValue, segments: string[]): JsonValue {
  const [head, ...rest] = segments as [string, ...string[]];
  if (doc === null || typeof doc !== "object") return doc;
  if (Array.isArray(doc)) {
    const index = Number.parseInt(head, 10);
    if (Number.isNaN(index) || index < 0 || index >= doc.length) return doc;
    const copy = doc.slice();
    if (rest.length === 0) copy.splice(index, 1);
    else copy[index] = removeSegments(copy[index] as JsonValue, rest);
    return copy;
  }
  if (!Object.prototype.hasOwnProperty.call(doc, head)) return doc;
  const copy: JsonObject = { ...doc };
  if (rest.length === 0) delete copy[head];
  else copy[head] = removeSegments(copy[head] as JsonValue, rest);
  return copy;
}
