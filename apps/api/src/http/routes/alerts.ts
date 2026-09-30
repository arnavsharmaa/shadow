import { createAlertRuleBodySchema, idSchema, updateAlertRuleBodySchema } from "@shadow/schemas";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  createAlertRule,
  deleteAlertRule,
  evaluateAlertRules,
  getAlertRule,
  listAlertRules,
  updateAlertRule,
} from "../../services/alerts.js";
import { audit } from "../audit.js";

const params = z.object({ ruleId: idSchema });

/** Threshold alerts over recent traces (failure rate, policy violations, tool errors, cost, latency). */
export const alertRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get("/alerts/rules", { schema: { tags: ["alerts"] } }, async () => ({
    items: await listAlertRules(app.services),
  }));

  app.post(
    "/alerts/rules",
    { schema: { tags: ["alerts"], body: createAlertRuleBodySchema } },
    async (request, reply) => {
      const rule = await createAlertRule(app.services, request.body);
      await audit(app, request, {
        action: "alert.created",
        targetType: "alert",
        targetId: rule.id,
        details: {
          name: rule.name,
          agent: rule.agent,
          metric: rule.metric,
          threshold: rule.threshold,
          windowMinutes: rule.windowMinutes,
        },
      });
      return reply.status(201).send(rule);
    },
  );

  app.get("/alerts/rules/:ruleId", { schema: { tags: ["alerts"], params } }, async (request) =>
    getAlertRule(app.services, request.params.ruleId),
  );

  app.patch(
    "/alerts/rules/:ruleId",
    { schema: { tags: ["alerts"], params, body: updateAlertRuleBodySchema } },
    async (request) => {
      const rule = await updateAlertRule(app.services, request.params.ruleId, request.body);
      await audit(app, request, {
        action: "alert.updated",
        targetType: "alert",
        targetId: rule.id,
        details: { name: rule.name, changes: request.body },
      });
      return rule;
    },
  );

  app.delete(
    "/alerts/rules/:ruleId",
    { schema: { tags: ["alerts"], params } },
    async (request, reply) => {
      const rule = await deleteAlertRule(app.services, request.params.ruleId);
      await audit(app, request, {
        action: "alert.deleted",
        targetType: "alert",
        targetId: rule.id,
        details: { name: rule.name },
      });
      return reply.status(204).send();
    },
  );

  /** Evaluate every enabled rule now instead of waiting for the timer. */
  app.post("/alerts/evaluate", { schema: { tags: ["alerts"] } }, async () => ({
    items: await evaluateAlertRules(app.services),
  }));
};
