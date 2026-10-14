import { createHash, randomBytes } from "node:crypto";
import type { ApiKey, ApiKeyScope, CreateApiKeyBody } from "@shadow/schemas";
import { and, asc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { apiKeys } from "../db/schema.js";
import { ApiError } from "../errors.js";
import type { ServiceContext } from "./context.js";
import { iso } from "./mappers.js";

export const KEY_PREFIX = "shk_";
export const MAX_API_KEYS = 200;
/** How often a key's `lastUsedAt` is written; every request would be too chatty. */
const LAST_USED_INTERVAL_MS = 60_000;

type KeyRow = typeof apiKeys.$inferSelect;

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function toApiKey(row: KeyRow): ApiKey {
  return {
    id: row.id,
    name: row.name,
    scope: row.scope as ApiKeyScope,
    project: row.project,
    prefix: row.prefix,
    createdAt: iso(row.createdAt),
    lastUsedAt: row.lastUsedAt ? iso(row.lastUsedAt) : null,
    revokedAt: row.revokedAt ? iso(row.revokedAt) : null,
    expiresAt: row.expiresAt ? iso(row.expiresAt) : null,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function listApiKeys(ctx: ServiceContext): Promise<ApiKey[]> {
  const rows = await ctx.handle.db
    .select()
    .from(apiKeys)
    .orderBy(asc(apiKeys.name))
    .limit(MAX_API_KEYS);
  return rows.map(toApiKey);
}

/** Create a key. The secret is returned once and never stored. */
export async function createApiKey(
  ctx: ServiceContext,
  body: CreateApiKeyBody,
): Promise<{ key: ApiKey; secret: string }> {
  const [clash] = await ctx.handle.db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(eq(apiKeys.name, body.name))
    .limit(1);
  if (clash) throw ApiError.conflict(`an API key named '${body.name}' already exists`);
  if (body.project && body.scope === "admin") {
    throw ApiError.badRequest("admin keys cannot be pinned to a project");
  }
  const [counted] = await ctx.handle.db.select({ count: sql<number>`count(*)::int` }).from(apiKeys);
  if (Number(counted?.count ?? 0) >= MAX_API_KEYS) {
    throw ApiError.badRequest(`at most ${MAX_API_KEYS} API keys can be stored`);
  }
  const secret = issueSecret();
  const now = ctx.clock.now();
  const row: KeyRow = {
    id: ctx.ids.next("key"),
    name: body.name,
    scope: body.scope,
    project: body.project ?? null,
    prefix: prefixOf(secret),
    secretHash: hashSecret(secret),
    createdAt: iso(new Date(now)),
    lastUsedAt: null,
    revokedAt: null,
    expiresAt: body.expiresInDays ? iso(new Date(now + body.expiresInDays * DAY_MS)) : null,
  };
  await ctx.handle.db.insert(apiKeys).values(row);
  return { key: toApiKey(row), secret };
}

function issueSecret(): string {
  return `${KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
}

function prefixOf(secret: string): string {
  return secret.slice(0, KEY_PREFIX.length + 8);
}

/** The name a retired key keeps after rotation, so its history stays readable and the new key can take the name. */
export function retiredName(name: string, at: Date): string {
  const suffix = `:rotated:${at.toISOString().replace(/[-:]/g, "").slice(0, 15)}`;
  return `${name.slice(0, 64 - suffix.length)}${suffix}`;
}

/**
 * Replace a key's secret in one step: the current key is retired (revoked and renamed with a
 * `:rotated:<stamp>` suffix) and a new key with the same name, scope, project pin and expiry
 * is issued. The old secret stops working immediately; the new one is returned once.
 */
export async function rotateApiKey(
  ctx: ServiceContext,
  idOrName: string,
): Promise<{ key: ApiKey; secret: string; retired: ApiKey }> {
  const [current] = await ctx.handle.db
    .select()
    .from(apiKeys)
    .where(
      and(
        idOrName.startsWith("key_") ? eq(apiKeys.id, idOrName) : eq(apiKeys.name, idOrName),
        isNull(apiKeys.revokedAt),
      ),
    )
    .limit(1);
  if (!current) throw ApiError.notFound("API key", idOrName);
  const now = new Date(ctx.clock.now());
  const secret = issueSecret();
  const next: KeyRow = {
    ...current,
    id: ctx.ids.next("key"),
    prefix: prefixOf(secret),
    secretHash: hashSecret(secret),
    createdAt: iso(now),
    lastUsedAt: null,
    revokedAt: null,
  };
  const retired = await ctx.handle.db.transaction(async (tx) => {
    const [old] = await tx
      .update(apiKeys)
      .set({ name: retiredName(current.name, now), revokedAt: iso(now) })
      .where(eq(apiKeys.id, current.id))
      .returning();
    await tx.insert(apiKeys).values(next);
    return old as KeyRow;
  });
  return { key: toApiKey(next), secret, retired: toApiKey(retired) };
}

/** Revoke a key by id or name; a revoked key is refused from the next request on. */
export async function revokeApiKey(ctx: ServiceContext, idOrName: string): Promise<ApiKey> {
  const [row] = await ctx.handle.db
    .update(apiKeys)
    .set({ revokedAt: iso(new Date(ctx.clock.now())) })
    .where(
      and(
        idOrName.startsWith("key_") ? eq(apiKeys.id, idOrName) : eq(apiKeys.name, idOrName),
        isNull(apiKeys.revokedAt),
      ),
    )
    .returning();
  if (!row) throw ApiError.notFound("API key", idOrName);
  return toApiKey(row);
}

/**
 * Resolve a presented secret to its key, or `null` when it is unknown, revoked or expired.
 * Looking up by hash means a wrong secret costs one indexed read and leaks nothing about
 * existing keys.
 */
export async function authenticateApiKey(
  ctx: ServiceContext,
  secret: string,
): Promise<ApiKey | null> {
  if (!secret.startsWith(KEY_PREFIX) || secret.length > 128) return null;
  const now = ctx.clock.now();
  const [row] = await ctx.handle.db
    .select()
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.secretHash, hashSecret(secret)),
        isNull(apiKeys.revokedAt),
        or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, iso(new Date(now)))),
      ),
    )
    .limit(1);
  if (!row) return null;
  const lastUsed = row.lastUsedAt ? Date.parse(iso(row.lastUsedAt)) : 0;
  if (now - lastUsed >= LAST_USED_INTERVAL_MS) {
    // Best effort and off the request path.
    void ctx.handle.db
      .update(apiKeys)
      .set({ lastUsedAt: iso(new Date(now)) })
      .where(eq(apiKeys.id, row.id))
      .catch((error: unknown) => ctx.logger.warn({ err: error }, "could not stamp API key use"));
  }
  return toApiKey(row);
}

/** Request shapes an `ingest` key may make: everything the SDK, OTLP exporters and importers send. */
const INGEST_ROUTES: { method: string; pattern: RegExp }[] = [
  { method: "POST", pattern: /^\/api\/v1\/traces$/ },
  { method: "POST", pattern: /^\/api\/v1\/traces\/[^/]+\/(events|artifacts)$/ },
  { method: "PATCH", pattern: /^\/api\/v1\/traces\/[^/]+$/ },
  { method: "POST", pattern: /^\/api\/v1\/traces\/import$/ },
  { method: "POST", pattern: /^\/api\/v1\/otlp\/v1\/traces$/ },
  { method: "POST", pattern: /^\/api\/v1\/import\/[^/]+$/ },
];

/** Whether a key's scope permits this request. */
export function scopeAllows(scope: ApiKeyScope, method: string, url: string): boolean {
  if (scope === "admin") return true;
  const path = url.split("?")[0] ?? url;
  if (scope === "read") return method === "GET" || method === "HEAD";
  return INGEST_ROUTES.some((r) => r.method === method && r.pattern.test(path));
}
