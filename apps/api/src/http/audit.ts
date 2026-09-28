import type { FastifyInstance, FastifyRequest } from "fastify";
import { actorFrom, recordAudit, type AuditInput } from "../services/audit.js";

/** Record an audit entry for a successful state-changing request. */
export async function audit(
  app: FastifyInstance,
  request: FastifyRequest,
  entry: Omit<AuditInput, "actor" | "requestId">,
): Promise<void> {
  await recordAudit(app.services, {
    ...entry,
    actor: actorFrom(request.headers["x-shadow-actor"]),
    requestId: request.id,
  });
}
