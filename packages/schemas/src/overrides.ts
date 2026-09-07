import { z } from "zod";
import { jsonObjectSchema, jsonValueSchema } from "./json.js";
import { jsonPointerSchema } from "./state.js";

const overrideBase = {
  id: z.string().max(128).optional(),
  label: z.string().max(256).optional(),
};

/** Add, replace or remove a context value the agent "knows". */
export const contextOverrideSchema = z.object({
  ...overrideBase,
  kind: z.literal("context"),
  op: z.enum(["set", "remove"]),
  key: z.string().min(1).max(256),
  value: jsonValueSchema.optional(),
});

/** Modify an arbitrary field of the agent state (JSON pointer path). */
export const stateOverrideSchema = z.object({
  ...overrideBase,
  kind: z.literal("state"),
  op: z.enum(["set", "remove"]),
  path: jsonPointerSchema,
  value: jsonValueSchema.optional(),
});

/** Replace the recorded result of a tool call. */
export const toolResultOverrideSchema = z.object({
  ...overrideBase,
  kind: z.literal("tool_result"),
  tool: z.string().min(1).max(128),
  /** 1-based occurrence of the tool after the fork point (default: first). */
  occurrence: z.number().int().positive().default(1),
  result: jsonValueSchema,
});

/** Make a tool call fail. */
export const toolErrorOverrideSchema = z.object({
  ...overrideBase,
  kind: z.literal("tool_error"),
  tool: z.string().min(1).max(128),
  occurrence: z.number().int().positive().default(1),
  error: z.object({
    message: z.string().min(1).max(2000),
    code: z.string().max(64).optional(),
    retryable: z.boolean().optional(),
  }),
});

/** Reconfigure a policy (for example an approval threshold). */
export const policyOverrideSchema = z.object({
  ...overrideBase,
  kind: z.literal("policy"),
  policy: z.string().min(1).max(128),
  config: jsonObjectSchema,
});

export const overrideSchema = z.discriminatedUnion("kind", [
  contextOverrideSchema,
  stateOverrideSchema,
  toolResultOverrideSchema,
  toolErrorOverrideSchema,
  policyOverrideSchema,
]);

export type Override = z.infer<typeof overrideSchema>;
export type OverrideInput = z.input<typeof overrideSchema>;
export type ContextOverride = z.infer<typeof contextOverrideSchema>;
export type StateOverride = z.infer<typeof stateOverrideSchema>;
export type ToolResultOverride = z.infer<typeof toolResultOverrideSchema>;
export type ToolErrorOverride = z.infer<typeof toolErrorOverrideSchema>;
export type PolicyOverride = z.infer<typeof policyOverrideSchema>;
export type OverrideKind = Override["kind"];

export const OVERRIDE_KINDS = ["context", "state", "tool_result", "tool_error", "policy"] as const;
