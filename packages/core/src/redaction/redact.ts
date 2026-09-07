import type { JsonValue } from "@shadow/schemas";

export interface RedactionOptions {
  /** Regular expressions tested against object keys (case-insensitive). */
  keyPatterns?: RegExp[];
  /** Regular expressions tested against string values. */
  valuePatterns?: RegExp[];
  /** Extra key patterns appended to the defaults (strings are compiled). */
  additionalKeyPatterns?: (RegExp | string)[];
  replacement?: string;
}

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
  /client[-_]?secret/i,
  /set-cookie/i,
];

export const DEFAULT_VALUE_PATTERNS: RegExp[] = [
  /^Bearer\s+[A-Za-z0-9\-._~+/]+=*$/i,
  /^sk-[A-Za-z0-9_-]{16,}$/,
  /^ghp_[A-Za-z0-9]{20,}$/,
  /^xox[baprs]-[A-Za-z0-9-]{10,}$/,
  /^AKIA[0-9A-Z]{16}$/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

export const DEFAULT_REPLACEMENT = "[REDACTED]";

export interface Redactor {
  redact<T extends JsonValue | undefined>(value: T): T;
  isSensitiveKey(key: string): boolean;
  isSensitiveValue(value: string): boolean;
}

/** Parse a comma-separated list of patterns (from configuration). */
export function parsePatternList(list: string | undefined): RegExp[] {
  if (!list) return [];
  return list
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => new RegExp(p, "i"));
}

export function createRedactor(options: RedactionOptions = {}): Redactor {
  const keyPatterns = [
    ...(options.keyPatterns ?? DEFAULT_KEY_PATTERNS),
    ...(options.additionalKeyPatterns ?? []).map((p) =>
      typeof p === "string" ? new RegExp(p, "i") : p,
    ),
  ];
  const valuePatterns = options.valuePatterns ?? DEFAULT_VALUE_PATTERNS;
  const replacement = options.replacement ?? DEFAULT_REPLACEMENT;

  const isSensitiveKey = (key: string) => keyPatterns.some((p) => p.test(key));
  const isSensitiveValue = (value: string) => valuePatterns.some((p) => p.test(value));

  const walk = (value: JsonValue | undefined, depth: number): JsonValue | undefined => {
    if (depth > 64) return value;
    if (value === undefined || value === null) return value;
    if (typeof value === "string") return isSensitiveValue(value) ? replacement : value;
    if (typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((v) => walk(v, depth + 1) as JsonValue);
    const out: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = isSensitiveKey(key) ? replacement : (walk(child, depth + 1) as JsonValue);
    }
    return out;
  };

  return {
    redact: <T extends JsonValue | undefined>(value: T) => walk(value, 0) as T,
    isSensitiveKey,
    isSensitiveValue,
  };
}

export const defaultRedactor = createRedactor();
