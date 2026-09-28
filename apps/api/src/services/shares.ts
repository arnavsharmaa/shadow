import { createHash, randomBytes } from "node:crypto";
import type { CreateShareBody, TraceExport, TraceShare } from "@shadow/schemas";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { traceShares } from "../db/schema.js";
import { ApiError } from "../errors.js";
import type { ServiceContext } from "./context.js";
import { iso } from "./mappers.js";
import { getTraceRow } from "./traces.js";
import { exportTrace } from "./transfer.js";

const TOKEN_PREFIX = "shs_";
const HOUR_MS = 3_600_000;

type ShareRow = typeof traceShares.$inferSelect;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function toShare(row: ShareRow): TraceShare {
  return {
    id: row.id,
    traceId: row.traceId,
    note: row.note,
    createdAt: iso(row.createdAt),
    expiresAt: iso(row.expiresAt),
    revokedAt: row.revokedAt ? iso(row.revokedAt) : null,
    accessCount: row.accessCount,
    lastAccessedAt: row.lastAccessedAt ? iso(row.lastAccessedAt) : null,
  };
}

/** Create a read-only link; the returned token is never stored and cannot be shown again. */
export async function createShare(
  ctx: ServiceContext,
  traceId: string,
  body: CreateShareBody,
): Promise<{ share: TraceShare; token: string }> {
  await getTraceRow(ctx, traceId);
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const now = ctx.clock.now();
  const row: ShareRow = {
    id: ctx.ids.next("shr"),
    traceId,
    tokenHash: hashToken(token),
    note: body.note ?? null,
    createdAt: iso(new Date(now)),
    expiresAt: iso(new Date(now + body.expiresInHours * HOUR_MS)),
    revokedAt: null,
    accessCount: 0,
    lastAccessedAt: null,
  };
  await ctx.handle.db.insert(traceShares).values(row);
  return { share: toShare(row), token };
}

export async function listShares(ctx: ServiceContext, traceId: string): Promise<TraceShare[]> {
  await getTraceRow(ctx, traceId);
  const rows = await ctx.handle.db
    .select()
    .from(traceShares)
    .where(eq(traceShares.traceId, traceId))
    .orderBy(desc(traceShares.createdAt), desc(traceShares.id));
  return rows.map(toShare);
}

export async function revokeShare(
  ctx: ServiceContext,
  traceId: string,
  shareId: string,
): Promise<TraceShare> {
  const [row] = await ctx.handle.db
    .update(traceShares)
    .set({ revokedAt: iso(new Date(ctx.clock.now())) })
    .where(
      and(
        eq(traceShares.id, shareId),
        eq(traceShares.traceId, traceId),
        isNull(traceShares.revokedAt),
      ),
    )
    .returning();
  if (!row) throw ApiError.notFound("share", shareId);
  return toShare(row);
}

/**
 * Resolve a share token to the trace's export bundle. Unknown, expired and revoked tokens all
 * answer the same 404 so a link reveals nothing once it stops working.
 */
export async function openShare(ctx: ServiceContext, token: string): Promise<TraceExport> {
  const now = iso(new Date(ctx.clock.now()));
  const notFound = () => ApiError.notFound("share", "link");
  if (!token.startsWith(TOKEN_PREFIX) || token.length > 128) throw notFound();
  const [row] = await ctx.handle.db
    .update(traceShares)
    .set({ accessCount: sql`${traceShares.accessCount} + 1`, lastAccessedAt: now })
    .where(
      and(
        eq(traceShares.tokenHash, hashToken(token)),
        isNull(traceShares.revokedAt),
        gt(traceShares.expiresAt, now),
      ),
    )
    .returning();
  if (!row) throw notFound();
  return exportTrace(ctx, row.traceId);
}
