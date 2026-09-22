import {
  randomIdGenerator,
  systemClock,
  type Clock,
  type IdGenerator,
  type Redactor,
} from "@shadow/core";
import type { Logger } from "pino";
import type { DatabaseHandle } from "../db/client.js";
import { ShadowMetrics } from "../metrics/registry.js";
import { noopWebhook, type Webhook } from "../notify/webhook.js";
import type { AgentRegistry } from "../replay/registry.js";

/** Dependencies shared by every service function. */
export interface ServiceContext {
  handle: DatabaseHandle;
  logger: Logger;
  registry: AgentRegistry;
  ids: IdGenerator;
  clock: Clock;
  redactor: Redactor;
  /** Process-wide counters rendered by GET /metrics. */
  metrics: ShadowMetrics;
  /** Outgoing notifications for finished traces. */
  webhook: Webhook;
}

export function createServiceContext(
  input: Pick<ServiceContext, "handle" | "logger" | "registry" | "redactor"> &
    Partial<Pick<ServiceContext, "ids" | "clock" | "metrics" | "webhook">>,
): ServiceContext {
  return {
    ...input,
    ids: input.ids ?? randomIdGenerator(),
    clock: input.clock ?? systemClock,
    metrics: input.metrics ?? new ShadowMetrics(),
    webhook: input.webhook ?? noopWebhook,
  };
}

export function encodeCursor(sequence: number): string {
  return Buffer.from(JSON.stringify({ s: sequence }), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return -1;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { s?: unknown };
    if (typeof parsed.s === "number" && Number.isInteger(parsed.s)) return parsed.s;
  } catch {
    // fall through
  }
  throw new Error("invalid cursor");
}

export const INSERT_CHUNK = 500;

export function chunk<T>(items: readonly T[], size = INSERT_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
