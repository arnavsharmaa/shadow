import type { FastifyInstance, FastifyRequest } from "fastify";
import { actorFrom, recordAudit, type AuditInput } from "../services/audit.js";

/**
 * Who is making the request: the API key's name when one authenticated it (not what the
 * request claims), otherwise the self-reported `x-shadow-actor` header or `anonymous`.
 */
export function requestActor(request: FastifyRequest): string {
  return request.auth?.kind === "key"
    ? `key:${request.auth.key.name}`
    : actorFrom(request.headers["x-shadow-actor"]);
}

/** Record an audit entry for a successful state-changing request. */
export async function audit(
  app: FastifyInstance,
  request: FastifyRequest,
  entry: Omit<AuditInput, "actor" | "requestId">,
): Promise<void> {
  await recordAudit(app.services, {
    ...entry,
    actor: requestActor(request),
    requestId: request.id,
  });
}
