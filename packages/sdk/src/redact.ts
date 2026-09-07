import type { JsonValue } from "@shadow/schemas";

export interface RedactOptions {
  /** Extra key patterns (strings compile to case-insensitive regular expressions). */
  keyPatterns?: (RegExp | string)[];
  replacement?: string;
}

/**
 * Keys redacted before events leave the process. The server applies the
 * same defaults again; client-side redaction protects transport logs.
 */
export const DEFAULT_KEY_PATTERNS: RegExp[] = [
  /password/i,
  /passwd/i,
  /api[-_]?key/i,
  /authorization/i,
  /secret/i,
  /token/i,
  /cookie/i,
  /credential/i,
  /private[-_]?key/i,
];

export function createRedactor(options: RedactOptions = {}): (value: JsonValue) => JsonValue {
  const patterns = [
    ...DEFAULT_KEY_PATTERNS,
    ...(options.keyPatterns ?? []).map((p) => (typeof p === "string" ? new RegExp(p, "i") : p)),
  ];
  const replacement = options.replacement ?? "[REDACTED]";
  const walk = (value: JsonValue, depth: number): JsonValue => {
    if (depth > 64 || value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((v) => walk(v, depth + 1));
    const out: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = patterns.some((p) => p.test(key)) ? replacement : walk(child, depth + 1);
    }
    return out;
  };
  return (value) => walk(value, 0);
}
