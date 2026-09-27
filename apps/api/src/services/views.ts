import type { SavedView, SaveViewBody } from "@shadow/schemas";
import { asc, eq, sql } from "drizzle-orm";
import { savedViews } from "../db/schema.js";
import { ApiError } from "../errors.js";
import type { ServiceContext } from "./context.js";
import { iso, toSavedView } from "./mappers.js";

/** At most this many shared views; they are meant to be a short, curated list. */
export const MAX_SAVED_VIEWS = 200;

export async function listViews(ctx: ServiceContext): Promise<SavedView[]> {
  const rows = await ctx.handle.db
    .select()
    .from(savedViews)
    .orderBy(asc(savedViews.name))
    .limit(MAX_SAVED_VIEWS);
  return rows.map(toSavedView);
}

export async function getViewByName(ctx: ServiceContext, name: string): Promise<SavedView> {
  const [row] = await ctx.handle.db
    .select()
    .from(savedViews)
    .where(eq(savedViews.name, name))
    .limit(1);
  if (!row) throw ApiError.notFound("view", name);
  return toSavedView(row);
}

/** Create a view, or replace the query and description of the view with the same name. */
export async function saveView(
  ctx: ServiceContext,
  input: SaveViewBody,
): Promise<{ view: SavedView; created: boolean }> {
  const now = iso(new Date(ctx.clock.now()));
  const [existing] = await ctx.handle.db
    .select()
    .from(savedViews)
    .where(eq(savedViews.name, input.name))
    .limit(1);
  if (existing) {
    const [row] = await ctx.handle.db
      .update(savedViews)
      .set({ query: input.query, description: input.description ?? null, updatedAt: now })
      .where(eq(savedViews.id, existing.id))
      .returning();
    if (!row) throw ApiError.notFound("view", input.name);
    return { view: toSavedView(row), created: false };
  }
  const [counted] = await ctx.handle.db
    .select({ count: sql<number>`count(*)::int` })
    .from(savedViews);
  if (Number(counted?.count ?? 0) >= MAX_SAVED_VIEWS) {
    throw ApiError.badRequest(`at most ${MAX_SAVED_VIEWS} shared views can be stored`);
  }
  const row = {
    id: ctx.ids.next("view"),
    name: input.name,
    query: input.query,
    description: input.description ?? null,
    createdAt: now,
    updatedAt: now,
  };
  await ctx.handle.db.insert(savedViews).values(row);
  return { view: toSavedView(row), created: true };
}

export async function deleteView(ctx: ServiceContext, viewId: string): Promise<void> {
  const deleted = await ctx.handle.db
    .delete(savedViews)
    .where(eq(savedViews.id, viewId))
    .returning({ id: savedViews.id });
  if (deleted.length === 0) throw ApiError.notFound("view", viewId);
}
