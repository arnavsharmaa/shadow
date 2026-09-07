import { z } from "zod";
import { jsonObjectSchema, jsonValueSchema } from "./json.js";

/** JSON Pointer (RFC 6901). Empty string addresses the whole document. */
export const jsonPointerSchema = z
  .string()
  .max(1024)
  .refine((p) => p === "" || p.startsWith("/"), "path must be a JSON pointer starting with '/'");

/** A subset of RFC 6902 JSON Patch used for incremental state updates. */
export const patchOperationSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), path: jsonPointerSchema, value: jsonValueSchema }),
  z.object({ op: z.literal("replace"), path: jsonPointerSchema, value: jsonValueSchema }),
  z.object({ op: z.literal("remove"), path: jsonPointerSchema }),
]);
export type PatchOperation = z.infer<typeof patchOperationSchema>;

/** Payload of a `state.snapshot` event. */
export const stateSnapshotPayloadSchema = z.object({
  state: jsonObjectSchema,
  context: jsonObjectSchema,
});
export type StateSnapshotPayload = z.infer<typeof stateSnapshotPayloadSchema>;

/** Payload of a `state.patch` event. */
export const statePatchPayloadSchema = z.object({
  ops: z.array(patchOperationSchema).max(10_000),
});
export type StatePatchPayload = z.infer<typeof statePatchPayloadSchema>;

/** Fully materialised agent knowledge at an event boundary. */
export const reconstructedStateSchema = z.object({
  state: jsonObjectSchema,
  context: jsonObjectSchema,
  stateVersion: z.number().int().nonnegative(),
  /** Sequence of the last event applied (inclusive). -1 when nothing applied. */
  asOfSequence: z.number().int().min(-1),
  /** Sequence of the snapshot the reconstruction started from, if any. */
  fromSnapshotSequence: z.number().int().nullable(),
  appliedEvents: z.number().int().nonnegative(),
});
export type ReconstructedState = z.infer<typeof reconstructedStateSchema>;

export const diffEntrySchema = z.object({
  path: z.string(),
  op: z.enum(["added", "removed", "changed"]),
  before: jsonValueSchema.optional(),
  after: jsonValueSchema.optional(),
});
export type DiffEntry = z.infer<typeof diffEntrySchema>;
