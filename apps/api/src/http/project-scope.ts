import type { FastifyReply, FastifyRequest } from "fastify";
import { ApiError } from "../errors.js";
import { getBranch } from "../services/branches.js";
import { getComparison } from "../services/comparisons.js";
import type { ServiceContext } from "../services/context.js";
import { getTraceSummary } from "../services/traces.js";

/**
 * Keeps a key that is pinned to a project inside that project. Runs after body validation.
 *
 * - Recording (`ingest` keys): trace creation and bundle imports must name the key's project; the
 *   OTLP and conversation import routes apply the pin themselves, since their project may come
 *   from the payload or a default.
 * - Reading (`read` keys): requests about an existing trace, branch or comparison must concern a
 *   trace of the project; project-filtered listings and statistics get the pin as their filter
 *   and refuse another one; the project and agent listings filter themselves (see the routes).
 *   Everything else under `/api/v1` is not scoped to a project and is refused.
 */
export function projectOf(request: FastifyRequest): string | null {
  return request.auth?.kind === "key" ? request.auth.key.project : null;
}

/** Listings and statistics whose `project` query parameter the pin takes over. */
const PROJECT_FILTERED_ROUTES = new Set([
  "/api/v1/traces",
  "/api/v1/traces/facets",
  "/api/v1/stats/agents",
  "/api/v1/stats/overview",
  "/api/v1/stats/agents/:agentSlug/timeseries",
]);

/** Routes that apply the pin themselves or carry nothing project-specific. */
const SELF_SCOPED_ROUTES = new Set([
  "/api/v1/otlp/v1/traces",
  "/api/v1/import/anthropic",
  "/api/v1/projects",
  "/api/v1/agents",
  "/api/v1/pricing",
  "/api/v1/shared/:token",
]);

function refuse(reply: FastifyReply, request: FastifyRequest, message: string) {
  return reply.status(403).send({
    error: { code: "forbidden", message, requestId: request.id },
  });
}

function refuseProject(
  reply: FastifyReply,
  request: FastifyRequest,
  project: string,
  wanted: string,
  verb: string,
) {
  return refuse(
    reply,
    request,
    `this API key is pinned to project '${project}' and cannot ${verb} '${wanted}'`,
  );
}

/** The project of a trace, or `null` when the trace does not exist (the route answers that). */
async function traceProject(services: ServiceContext, traceId: string): Promise<string | null> {
  try {
    return (await getTraceSummary(services, traceId)).projectSlug;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

export async function enforceProjectScope(
  services: ServiceContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const project = projectOf(request);
  if (!project) return;
  const route = request.routeOptions.url ?? "";
  if (!route.startsWith("/api/v1/")) return;
  const verb =
    request.auth?.kind === "key" && request.auth.key.scope === "read" ? "read" : "record into";
  const body = (request.body ?? {}) as Record<string, unknown>;
  const query = (request.query ?? {}) as Record<string, unknown>;
  const params = request.params as { traceId?: string; branchId?: string; comparisonId?: string };

  if (route === "/api/v1/traces" && request.method === "POST") {
    if (body.project !== project) {
      return refuseProject(reply, request, project, String(body.project), verb);
    }
    return;
  }
  if (route === "/api/v1/traces/import" && request.method === "POST") {
    const bundle = body.bundle as { project?: { slug?: unknown } } | undefined;
    const wanted = bundle?.project?.slug;
    if (wanted !== project) return refuseProject(reply, request, project, String(wanted), verb);
    return;
  }
  if (SELF_SCOPED_ROUTES.has(route)) return;

  let traceId: string | null;
  if (route.startsWith("/api/v1/traces/:traceId") && params.traceId) {
    traceId = params.traceId;
  } else if (route.startsWith("/api/v1/branches/:branchId") && params.branchId) {
    traceId = await ownerOf(() => getBranch(services, params.branchId ?? ""));
  } else if (route === "/api/v1/comparisons/:comparisonId" && params.comparisonId) {
    traceId = await ownerOf(() => getComparison(services, params.comparisonId ?? ""));
  } else if (route === "/api/v1/comparisons") {
    if (typeof query.traceId !== "string") {
      return refuse(
        reply,
        request,
        `this API key is pinned to project '${project}'; list comparisons of one of its traces with traceId`,
      );
    }
    traceId = query.traceId;
  } else if (PROJECT_FILTERED_ROUTES.has(route)) {
    if (query.project !== undefined && query.project !== project) {
      return refuseProject(reply, request, project, String(query.project), verb);
    }
    query.project = project;
    return;
  } else {
    return refuse(
      reply,
      request,
      `this API key is pinned to project '${project}'; ${request.method} ${route.replace(/^\/api\/v1/, "")} is not scoped to a project`,
    );
  }
  if (traceId === null) return;
  const owner = await traceProject(services, traceId);
  if (owner !== null && owner !== project)
    return refuseProject(reply, request, project, owner, verb);
}

/** The trace a branch or comparison belongs to, or `null` when it does not exist. */
async function ownerOf(load: () => Promise<{ traceId: string }>): Promise<string | null> {
  try {
    return (await load()).traceId;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}
