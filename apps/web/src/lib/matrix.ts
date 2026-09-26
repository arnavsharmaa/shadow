import type { JsonObject, JsonValue, Override } from "@shadow/schemas";

/** What a scenario matrix varies: a context value, a tool's next result or a policy's configuration. */
export type MatrixAxis = "context" | "tool_result" | "policy";

function parseValue(text: string): JsonValue {
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return text;
  }
}

/**
 * Split the values box into one JSON value per variant. Values go one per line; a single
 * line of scalars may also be comma separated (`50, 100, 500`). Lines that look like JSON
 * objects, arrays or strings are never split on commas.
 */
export function parseMatrixValues(text: string): JsonValue[] {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const single = lines.length === 1 ? (lines[0] ?? "") : null;
  if (single !== null && !/^[[{"]/.test(single)) {
    return single
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
      .map(parseValue);
  }
  return lines.map(parseValue);
}

function isObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Build the override for one variant of the chosen axis, or explain why the value is invalid. */
export function matrixOverride(
  axis: MatrixAxis,
  field: string,
  value: JsonValue,
): { override: Override } | { error: string } {
  const name = field.trim();
  switch (axis) {
    case "context":
      return { override: { kind: "context", op: "set", key: name, value } };
    case "tool_result":
      return { override: { kind: "tool_result", tool: name, occurrence: 1, result: value } };
    case "policy":
      if (!isObject(value)) return { error: "policy configurations must be JSON objects" };
      return { override: { kind: "policy", policy: name, config: value } };
  }
}

/** Name a variant the way the CLI does: `field=<json value>`, truncated for branch names. */
export function matrixVariantName(field: string, value: JsonValue): string {
  return `${field.trim()}=${JSON.stringify(value)}`.slice(0, 120);
}
