import { toJson } from "@shadow/core";
import type { AuditAction, AuditEntry, AuditListQuery, JsonObject } from "@shadow/schemas";
import { and, desc, eq, lt, type SQL } from "drizzle-orm";
import { auditLog } from "../db/schema.js";
import { ApiError } from "../errors.js";
import type { ServiceContext } from "./context.js";
import { iso } from "./mappers.js";

export interface AuditInput {
  actor: string;
  action: AuditAction;
  targetType: "trace" | "branch" | "comparison" | "artifact" | "job" | "view" | "alert";
  targetId: string;
  traceId?: string | null;
  details?: Record<string, unknown>;
  requestId?: string | null;
}

const ACTOR_PATTERN = /^[\w .@:+/-]{1,128}$/u;

/**
 * The actor a client reports in `x-shadow-actor` (CLI: the OS user; web app: `web`). It is
 * self-reported, not authenticated: anything that does not look like a plain name becomes
 * `anonymous` rather than being stored verbatim.
 */
export function actorFrom(header: string | string[] | undefined): string {
  const value = (Array.isArray(header) ? header[0] : header)?.trim();
  return value && ACTOR_PATTERN.test(value) ? value : "anonymous";
}

/** Append one entry. The audit log is best effort: a failed write is logged, never thrown. */
export async function recordAudit(ctx: ServiceContext, input: AuditInput): Promise<void> {
  try {
    await ctx.handle.db.insert(auditLog).values({
      id: ctx.ids.next("aud"),
      at: iso(new Date(ctx.clock.now())),
      actor: input.actor,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      traceId: input.traceId ?? null,
      details: toJson(ctx.redactor.redact(toJson(input.details ?? {}))),
      requestId: input.requestId ?? null,
    });
  } catch (error) {
    ctx.logger.error({ err: error, action: input.action }, "audit write failed");
  }
}

function decodeCursor(raw: string | undefined): number | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { s?: unknown };
    if (typeof parsed.s === "number" && Number.isSafeInteger(parsed.s)) return parsed.s;
  } catch {
    // fall through
  }
  throw ApiError.badRequest("invalid cursor");
}

type AuditRow = typeof auditLog.$inferSelect;

function toAuditEntry(row: AuditRow): AuditEntry {
  return {
    id: row.id,
    at: iso(row.at),
    actor: row.actor,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    traceId: row.traceId,
    details: row.details as JsonObject,
    requestId: row.requestId,
  };
}

/** Newest first, keyset-paginated on the insertion sequence. */
export async function listAudit(
  ctx: ServiceContext,
  query: AuditListQuery,
): Promise<{ items: AuditEntry[]; nextCursor: string | null }> {
  const filters: SQL[] = [];
  const after = decodeCursor(query.cursor);
  if (after !== null) filters.push(lt(auditLog.seq, after));
  if (query.traceId) filters.push(eq(auditLog.traceId, query.traceId));
  if (query.action) filters.push(eq(auditLog.action, query.action));
  if (query.actor) filters.push(eq(auditLog.actor, query.actor));
  const rows = await ctx.handle.db
    .select()
    .from(auditLog)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(auditLog.seq))
    .limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return {
    items: page.map(toAuditEntry),
    nextCursor:
      rows.length > query.limit && last
        ? Buffer.from(JSON.stringify({ s: last.seq }), "utf8").toString("base64url")
        : null,
  };
}
