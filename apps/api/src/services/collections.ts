import type { Collection, CreateCollectionBody, UpdateCollectionBody } from "@shadow/schemas";
import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { collectionTraces, collections, traces } from "../db/schema.js";
import { ApiError } from "../errors.js";
import type { ServiceContext } from "./context.js";
import { iso } from "./mappers.js";

export const MAX_COLLECTIONS = 500;

type CollectionRow = typeof collections.$inferSelect;

function toCollection(row: CollectionRow, traceCount: number): Collection {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    traceCount,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

const traceCount = sql<number>`(select count(*) from ${collectionTraces} where ${collectionTraces.collectionId} = ${collections.id})`;

export async function listCollections(
  ctx: ServiceContext,
  query: { traceId?: string } = {},
): Promise<Collection[]> {
  const filters: SQL[] = [];
  if (query.traceId) {
    filters.push(
      sql`exists (select 1 from ${collectionTraces} where ${collectionTraces.collectionId} = ${collections.id} and ${collectionTraces.traceId} = ${query.traceId})`,
    );
  }
  const rows = await ctx.handle.db
    .select({ collection: collections, traceCount })
    .from(collections)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(asc(collections.name))
    .limit(MAX_COLLECTIONS);
  return rows.map((r) => toCollection(r.collection, Number(r.traceCount)));
}

/** Look a collection up by id (`col_…`) or by name. */
export async function getCollection(ctx: ServiceContext, idOrName: string): Promise<Collection> {
  const [row] = await ctx.handle.db
    .select({ collection: collections, traceCount })
    .from(collections)
    .where(
      idOrName.startsWith("col_") ? eq(collections.id, idOrName) : eq(collections.name, idOrName),
    )
    .limit(1);
  if (!row) throw ApiError.notFound("collection", idOrName);
  return toCollection(row.collection, Number(row.traceCount));
}

async function assertNameFree(ctx: ServiceContext, name: string): Promise<void> {
  const [clash] = await ctx.handle.db
    .select({ id: collections.id })
    .from(collections)
    .where(eq(collections.name, name))
    .limit(1);
  if (clash) throw ApiError.conflict(`a collection named '${name}' already exists`);
}

export async function createCollection(
  ctx: ServiceContext,
  body: CreateCollectionBody,
): Promise<{ collection: Collection; added: string[]; missing: string[] }> {
  await assertNameFree(ctx, body.name);
  const [counted] = await ctx.handle.db
    .select({ count: sql<number>`count(*)::int` })
    .from(collections);
  if (Number(counted?.count ?? 0) >= MAX_COLLECTIONS) {
    throw ApiError.badRequest(`at most ${MAX_COLLECTIONS} collections can be stored`);
  }
  const at = iso(new Date(ctx.clock.now()));
  const row: CollectionRow = {
    id: ctx.ids.next("col"),
    name: body.name,
    description: body.description ?? null,
    createdAt: at,
    updatedAt: at,
  };
  await ctx.handle.db.insert(collections).values(row);
  const result =
    body.traceIds.length > 0
      ? await addTraces(ctx, row.id, body.traceIds)
      : { added: [], missing: [] };
  return { collection: await getCollection(ctx, row.id), ...result };
}

export async function updateCollection(
  ctx: ServiceContext,
  idOrName: string,
  body: UpdateCollectionBody,
): Promise<Collection> {
  const current = await getCollection(ctx, idOrName);
  if (body.name !== undefined && body.name !== current.name) await assertNameFree(ctx, body.name);
  await ctx.handle.db
    .update(collections)
    .set({ ...body, updatedAt: iso(new Date(ctx.clock.now())) })
    .where(eq(collections.id, current.id));
  return getCollection(ctx, current.id);
}

/** Deletes the collection; its traces are untouched. */
export async function deleteCollection(ctx: ServiceContext, idOrName: string): Promise<Collection> {
  const current = await getCollection(ctx, idOrName);
  await ctx.handle.db.delete(collections).where(eq(collections.id, current.id));
  return current;
}

/**
 * Add traces to a collection. Traces already in it are left alone and unknown ids are reported
 * rather than failing the call, so a list gathered earlier can be applied after a prune.
 */
export async function addTraces(
  ctx: ServiceContext,
  idOrName: string,
  traceIds: readonly string[],
): Promise<{ added: string[]; missing: string[] }> {
  const collection = await getCollection(ctx, idOrName);
  const unique = [...new Set(traceIds)];
  const found = await ctx.handle.db
    .select({ id: traces.id })
    .from(traces)
    .where(inArray(traces.id, unique));
  const existing = new Set(found.map((f) => f.id));
  const present = unique.filter((id) => existing.has(id));
  const added =
    present.length > 0
      ? await ctx.handle.db
          .insert(collectionTraces)
          .values(
            present.map((traceId) => ({
              collectionId: collection.id,
              traceId,
              addedAt: iso(new Date(ctx.clock.now())),
            })),
          )
          .onConflictDoNothing()
          .returning({ traceId: collectionTraces.traceId })
      : [];
  if (added.length > 0) {
    await ctx.handle.db
      .update(collections)
      .set({ updatedAt: iso(new Date(ctx.clock.now())) })
      .where(eq(collections.id, collection.id));
  }
  return {
    added: added.map((a) => a.traceId),
    missing: unique.filter((id) => !existing.has(id)),
  };
}

export async function removeTrace(
  ctx: ServiceContext,
  idOrName: string,
  traceId: string,
): Promise<Collection> {
  const collection = await getCollection(ctx, idOrName);
  const removed = await ctx.handle.db
    .delete(collectionTraces)
    .where(
      and(eq(collectionTraces.collectionId, collection.id), eq(collectionTraces.traceId, traceId)),
    )
    .returning({ traceId: collectionTraces.traceId });
  if (removed.length === 0) {
    throw ApiError.notFound("trace in collection", traceId);
  }
  return getCollection(ctx, collection.id);
}
