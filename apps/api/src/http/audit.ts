import type { FastifyInstance, FastifyRequest } from "fastify";
import { actorFrom, recordAudit, type AuditInput } from "../services/audit.js";

/** Record an audit entry for a successful state-changing request. */
export async function audit(
  app: FastifyInstance,
  request: FastifyRequest,
  entry: Omit<AuditInput, "actor" | "requestId">,
): Promise<void> {
  // A request authenticated with an API key is attributed to the key, not to what it claims.
  const actor =
    request.auth?.kind === "key"
      ? `key:${request.auth.key.name}`
      : actorFrom(request.headers["x-shadow-actor"]);
  await recordAudit(app.services, { ...entry, actor, requestId: request.id });
}
