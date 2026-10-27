import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { ApiError } from "../../errors.js";
import { audit } from "../audit.js";

/** Operations on the outgoing webhook; the delivery itself is configured by environment. */
export const webhookRoutes: FastifyPluginAsyncZod = async (app) => {
  /**
   * Send a test notification to the configured webhook and report how the delivery went, so
   * a new URL, secret or chat format can be checked before the first real alert.
   */
  app.post("/webhook/test", { schema: { tags: ["webhook"] } }, async (request) => {
    if (!app.services.webhook.enabled) {
      throw new ApiError(
        409,
        "webhook_not_configured",
        "no webhook is configured; set SHADOW_WEBHOOK_URL and restart the API",
      );
    }
    const probe = await app.services.webhook.test();
    await audit(app, request, {
      action: "webhook.tested",
      targetType: "webhook",
      targetId: "webhook",
      details: { delivered: probe.delivered, status: probe.status, error: probe.error },
    });
    return probe;
  });
};
