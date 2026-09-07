import type { Agent, JsonObject, Project } from "@shadow/schemas";
import { and, asc, eq } from "drizzle-orm";
import { agents, projects } from "../db/schema.js";
import { ApiError } from "../errors.js";
import type { ServiceContext } from "./context.js";
import { iso, toAgent, toProject } from "./mappers.js";

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function titleCase(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(" ");
}

export async function listProjects(ctx: ServiceContext): Promise<Project[]> {
  const rows = await ctx.handle.db.select().from(projects).orderBy(asc(projects.name));
  return rows.map(toProject);
}

export async function createProject(
  ctx: ServiceContext,
  input: { slug: string; name: string; description?: string; metadata?: JsonObject },
): Promise<Project> {
  const existing = await ctx.handle.db
    .select()
    .from(projects)
    .where(eq(projects.slug, input.slug))
    .limit(1);
  if (existing[0]) throw ApiError.conflict(`project '${input.slug}' already exists`);
  const now = iso(new Date(ctx.clock.now()));
  const [row] = await ctx.handle.db
    .insert(projects)
    .values({
      id: ctx.ids.next("prj"),
      slug: input.slug,
      name: input.name,
      description: input.description ?? null,
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return toProject(row as typeof projects.$inferSelect);
}

/** Find a project by slug, creating it on first use. */
export async function ensureProject(
  ctx: ServiceContext,
  input: { slug: string; name?: string; description?: string | null; metadata?: JsonObject },
): Promise<Project> {
  const slug = slugify(input.slug);
  if (!slug) throw ApiError.badRequest("project slug must contain letters or digits");
  const existing = await ctx.handle.db
    .select()
    .from(projects)
    .where(eq(projects.slug, slug))
    .limit(1);
  if (existing[0]) return toProject(existing[0]);
  const now = iso(new Date(ctx.clock.now()));
  const [row] = await ctx.handle.db
    .insert(projects)
    .values({
      id: ctx.ids.next("prj"),
      slug,
      name: input.name ?? titleCase(slug),
      description: input.description ?? null,
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning();
  if (row) return toProject(row);
  const [again] = await ctx.handle.db
    .select()
    .from(projects)
    .where(eq(projects.slug, slug))
    .limit(1);
  return toProject(again as typeof projects.$inferSelect);
}

/** Find an agent by slug within a project, creating it on first use. */
export async function ensureAgent(
  ctx: ServiceContext,
  input: {
    projectId: string;
    slug: string;
    name?: string;
    description?: string | null;
    metadata?: JsonObject;
  },
): Promise<Agent> {
  const slug = slugify(input.slug);
  if (!slug) throw ApiError.badRequest("agent slug must contain letters or digits");
  const existing = await ctx.handle.db
    .select()
    .from(agents)
    .where(and(eq(agents.projectId, input.projectId), eq(agents.slug, slug)))
    .limit(1);
  const replayable = ctx.registry.has(slug);
  if (existing[0]) {
    if (existing[0].replayable !== replayable) {
      await ctx.handle.db.update(agents).set({ replayable }).where(eq(agents.id, existing[0].id));
    }
    return toAgent({ ...existing[0], replayable });
  }
  const [row] = await ctx.handle.db
    .insert(agents)
    .values({
      id: ctx.ids.next("agt"),
      projectId: input.projectId,
      slug,
      name: input.name ?? titleCase(slug),
      description: input.description ?? null,
      replayable,
      metadata: input.metadata ?? {},
      createdAt: iso(new Date(ctx.clock.now())),
    })
    .onConflictDoNothing()
    .returning();
  if (row) return toAgent(row);
  const [again] = await ctx.handle.db
    .select()
    .from(agents)
    .where(and(eq(agents.projectId, input.projectId), eq(agents.slug, slug)))
    .limit(1);
  return toAgent(again as typeof agents.$inferSelect);
}

export async function listAgents(ctx: ServiceContext, projectId?: string): Promise<Agent[]> {
  const rows = projectId
    ? await ctx.handle.db
        .select()
        .from(agents)
        .where(eq(agents.projectId, projectId))
        .orderBy(asc(agents.name))
    : await ctx.handle.db.select().from(agents).orderBy(asc(agents.name));
  return rows.map(toAgent);
}
