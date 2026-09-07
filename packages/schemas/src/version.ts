import { z } from "zod";

/**
 * Trace/event schema version, "MAJOR.MINOR".
 *
 * - MINOR increments for additive, backwards-compatible changes (new optional
 *   fields, new event types). Readers must ignore unknown fields.
 * - MAJOR increments for breaking changes. Readers must run an explicit
 *   migration (see `docs/concepts/schema-versioning.md`).
 */
export const SCHEMA_VERSION = "1.0" as const;
export const SCHEMA_MAJOR = 1;

export const schemaVersionSchema = z
  .string()
  .regex(/^\d+\.\d+$/, "schemaVersion must look like MAJOR.MINOR");

export type SchemaVersion = z.infer<typeof schemaVersionSchema>;

export function parseSchemaVersion(version: string): { major: number; minor: number } {
  const [major, minor] = version.split(".").map((part) => Number.parseInt(part, 10));
  if (major === undefined || minor === undefined || Number.isNaN(major) || Number.isNaN(minor)) {
    throw new Error(`Invalid schema version: ${version}`);
  }
  return { major, minor };
}

/** True when a reader written for SCHEMA_VERSION can consume `version`. */
export function isCompatibleSchemaVersion(version: string): boolean {
  try {
    return parseSchemaVersion(version).major === SCHEMA_MAJOR;
  } catch {
    return false;
  }
}
