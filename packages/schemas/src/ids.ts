import { z } from "zod";

/** Identifiers are opaque strings. Shadow generates prefixed UUIDs (`trc_…`). */
export const idSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/, "ids may only contain letters, digits, '_', '.', ':' and '-'");

export type Id = z.infer<typeof idSchema>;

export const ID_PREFIXES = {
  project: "prj",
  agent: "agt",
  trace: "trc",
  branch: "br",
  event: "evt",
  span: "spn",
  fork: "frk",
  replay: "rpl",
  comparison: "cmp",
  artifact: "art",
  approval: "apr",
} as const;

export type IdPrefix = (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES];
