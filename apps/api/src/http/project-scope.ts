import type { FastifyReply, FastifyRequest } from "fastify";
import { ApiError } from "../errors.js";
import type { ServiceContext } from "../services/context.js";
import { getTraceSummary } from "../services/traces.js";

/**
 * Keeps an `ingest` key that is pinned to a project inside that project. Runs after body
 * validation: trace creation and bundle imports must name the key's project, and requests about
 * an existing trace must concern a trace of that project. The OTLP and conversation import
 * routes apply the pin themselves, since their project may come from the payload or a default.
 */
export function projectOf(request: FastifyRequest): string | null {
  return request.auth?.kind === "key" ? request.auth.key.project : null;
}

function refuse(reply: FastifyReply, request: FastifyRequest, project: string, wanted: string) {
  return reply.status(403).send({
    error: {
      code: "forbidden",
      message: `this API key is pinned to project '${project}' and cannot record into '${wanted}'`,
      requestId: request.id,
    },
  });
}

export async function enforceProjectScope(
  services: ServiceContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const project = projectOf(request);
  if (!project) return;
  const route = request.routeOptions.url ?? "";
  const body = (request.body ?? {}) as Record<string, unknown>;
  if (route === "/api/v1/traces" && request.method === "POST") {
    if (body.project !== project) return refuse(reply, request, project, String(body.project));
    return;
  }
  if (route === "/api/v1/traces/import" && request.method === "POST") {
    const bundle = body.bundle as { project?: { slug?: unknown } } | undefined;
    const wanted = bundle?.project?.slug;
    if (wanted !== project) return refuse(reply, request, project, String(wanted));
    return;
  }
  const params = request.params as { traceId?: string };
  if (route.startsWith("/api/v1/traces/:traceId") && params.traceId) {
    try {
      const trace = await getTraceSummary(services, params.traceId);
      if (trace.projectSlug !== project) return refuse(reply, request, project, trace.projectSlug);
    } catch (error) {
      // An unknown trace is the route's business (404, or 202 when sampled out).
      if (!(error instanceof ApiError && error.status === 404)) throw error;
    }
  }
}
