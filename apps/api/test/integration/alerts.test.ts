import { VirtualClock } from "@shadow/core";
import type { AlertRule, AuditEntry } from "@shadow/schemas";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAlertEvaluator } from "../../src/alerts.js";
import { createLogger } from "../../src/logger.js";
import { createWebhook, type AlertNotification } from "../../src/notify/webhook.js";
import type { AlertEvaluation } from "../../src/services/alerts.js";
import { createTestApp, ingestRefundScenario, json, type TestApp } from "../helpers.js";

const clock = new VirtualClock(Date.parse("2026-09-01T10:00:00.000Z"));
const received: AlertNotification[] = [];
let t: TestApp;

async function createRule(body: Record<string, unknown>): Promise<AlertRule> {
  const response = await t.app.inject({
    method: "POST",
    url: "/api/v1/alerts/rules",
    headers: { "x-shadow-actor": "arnav" },
    payload: body,
  });
  expect(response.statusCode, response.body).toBe(201);
  return json<AlertRule>(response);
}

async function evaluate(): Promise<AlertEvaluation[]> {
  const response = await t.app.inject({ method: "POST", url: "/api/v1/alerts/evaluate" });
  expect(response.statusCode).toBe(200);
  await t.services.webhook.settle();
  return json<{ items: AlertEvaluation[] }>(response).items;
}

beforeAll(async () => {
  t = await createTestApp({ clock });
  t.services.webhook = createWebhook({
    config: {
      SHADOW_WEBHOOK_URL: "https://hooks.example.com/shadow",
      SHADOW_WEBHOOK_SECRET: undefined,
      // Alerts are delivered regardless of the finished-trace filter.
      SHADOW_WEBHOOK_EVENTS: "policy_violations",
    },
    logger: createLogger({ level: "silent" }),
    fetch: vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { type: string };
      if (body.type.startsWith("alert.")) received.push(body as AlertNotification);
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch,
  });
  // Two refund runs that both end in a policy violation, inside the last hour.
  await ingestRefundScenario(t, "trc_alert_a", { seed: "aa", startAt: "2026-09-01T09:00:00.000Z" });
  await ingestRefundScenario(t, "trc_alert_b", { seed: "ab", startAt: "2026-09-01T09:30:00.000Z" });
  received.length = 0;
});

afterAll(async () => {
  await t.close();
});

describe("alert rules", () => {
  it("fires once when a threshold is crossed and resolves when it recovers", async () => {
    const failures = await createRule({
      name: "refund failures",
      agent: "refund-agent",
      metric: "failure_rate",
      threshold: 0.5,
      windowMinutes: 120,
    });
    expect(failures).toMatchObject({ state: "ok", enabled: true, minTraces: 1, lastValue: null });
    await createRule({
      name: "many violations",
      metric: "policy_violations",
      threshold: 3,
      windowMinutes: 120,
    });
    await createRule({
      name: "needs volume",
      agent: "refund-agent",
      metric: "failure_rate",
      threshold: 0.1,
      windowMinutes: 120,
      minTraces: 5,
    });
    await createRule({
      name: "other agent",
      agent: "inventory-agent",
      metric: "tool_errors",
      threshold: 0,
      windowMinutes: 120,
    });

    const first = await evaluate();
    expect(first.map((e) => [e.rule.name, e.rule.state, e.transition])).toEqual([
      ["many violations", "ok", "none"],
      ["needs volume", "ok", "none"],
      ["other agent", "ok", "none"],
      ["refund failures", "firing", "fired"],
    ]);
    const fired = first.find((e) => e.rule.name === "refund failures")?.rule;
    expect(fired).toMatchObject({ lastValue: 1, lastTraces: 2 });
    expect(fired?.lastTriggeredAt).toBe("2026-09-01T10:00:00.000Z");
    expect(first.find((e) => e.rule.name === "many violations")?.rule.lastValue).toBe(2);
    // A threshold of 0 still needs traces in scope: no inventory traces, no alert.
    expect(first.find((e) => e.rule.name === "other agent")?.rule).toMatchObject({
      lastTraces: 0,
      state: "ok",
    });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      type: "alert.firing",
      rule: {
        name: "refund failures",
        agent: "refund-agent",
        metric: "failure_rate",
        threshold: 0.5,
      },
      value: 1,
      traces: 2,
    });

    // Still over the threshold: no repeat notification.
    clock.advance(5 * 60_000);
    const second = await evaluate();
    expect(second.every((e) => e.transition === "none")).toBe(true);
    expect(received).toHaveLength(1);
    expect(t.services.metrics.render()).toContain(
      'shadow_alert_transitions_total{transition="fired"} 1',
    );

    // The runs age out of the two-hour window and the rule recovers.
    clock.advance(3 * 60 * 60_000);
    const third = await evaluate();
    expect(third.find((e) => e.rule.name === "refund failures")).toMatchObject({
      transition: "resolved",
      rule: { state: "ok", lastValue: null, lastTraces: 0 },
    });
    expect(received.map((n) => n.type)).toEqual(["alert.firing", "alert.resolved"]);
  });

  it("measures cost, tool errors and latency, and respects disabled rules", async () => {
    const cost = await createRule({
      name: "cost",
      metric: "total_cost",
      threshold: 0.001,
      windowMinutes: 43_200,
    });
    const latency = await createRule({
      name: "latency",
      agent: "refund-agent",
      metric: "p95_duration_ms",
      threshold: 1000,
      windowMinutes: 43_200,
    });
    const items = await evaluate();
    const byName = new Map(items.map((e) => [e.rule.name, e]));
    expect(byName.get("cost")).toMatchObject({ transition: "fired", rule: { lastTraces: 2 } });
    expect(byName.get("cost")?.rule.lastValue).toBeGreaterThan(0.001);
    expect(byName.get("latency")?.rule.lastValue).toBeGreaterThan(1000);

    const disabled = await t.app.inject({
      method: "PATCH",
      url: `/api/v1/alerts/rules/${cost.id}`,
      payload: { enabled: false },
    });
    expect(json<AlertRule>(disabled)).toMatchObject({ enabled: false, state: "ok" });
    expect((await evaluate()).map((e) => e.rule.name)).not.toContain("cost");

    const raised = await t.app.inject({
      method: "PATCH",
      url: `/api/v1/alerts/rules/${latency.id}`,
      payload: { threshold: 60_000, name: "slow refunds" },
    });
    expect(json<AlertRule>(raised)).toMatchObject({ name: "slow refunds", threshold: 60_000 });
    expect((await evaluate()).find((e) => e.rule.name === "slow refunds")?.transition).toBe(
      "resolved",
    );
  });

  it("validates rules, audits changes and deletes", async () => {
    const tooHigh = await t.app.inject({
      method: "POST",
      url: "/api/v1/alerts/rules",
      payload: { name: "bad", metric: "failure_rate", threshold: 50 },
    });
    expect(tooHigh.statusCode).toBe(400);
    const unknownMetric = await t.app.inject({
      method: "POST",
      url: "/api/v1/alerts/rules",
      payload: { name: "bad", metric: "vibes", threshold: 1 },
    });
    expect(unknownMetric.statusCode).toBe(400);
    const duplicate = await t.app.inject({
      method: "POST",
      url: "/api/v1/alerts/rules",
      payload: { name: "refund failures", metric: "tool_errors", threshold: 1 },
    });
    expect(duplicate.statusCode).toBe(409);
    const empty = await t.app.inject({
      method: "PATCH",
      url: "/api/v1/alerts/rules/alr_missing",
      payload: {},
    });
    expect(empty.statusCode).toBe(400);

    const rules = json<{ items: AlertRule[] }>(await t.app.inject({ url: "/api/v1/alerts/rules" }));
    const target = rules.items.find((r) => r.name === "needs volume");
    expect(target).toBeDefined();
    const removed = await t.app.inject({
      method: "DELETE",
      url: `/api/v1/alerts/rules/${target?.id}`,
      headers: { "x-shadow-actor": "arnav" },
    });
    expect(removed.statusCode).toBe(204);
    expect((await t.app.inject({ url: `/api/v1/alerts/rules/${target?.id}` })).statusCode).toBe(
      404,
    );

    const log = json<{ items: AuditEntry[] }>(
      await t.app.inject({ url: "/api/v1/audit?actor=arnav&limit=500" }),
    );
    expect(log.items[0]).toMatchObject({
      action: "alert.deleted",
      details: { name: "needs volume" },
    });
    expect(log.items.filter((e) => e.action === "alert.created").length).toBeGreaterThanOrEqual(4);
  });

  it("runs on a timer only when an interval is configured", async () => {
    const off = createAlertEvaluator({
      services: t.services,
      config: { SHADOW_ALERT_INTERVAL_MINUTES: 0 },
      logger: t.services.logger,
    });
    expect(off.enabled).toBe(false);
    off.start();
    off.stop();
    const on = createAlertEvaluator({
      services: t.services,
      config: { SHADOW_ALERT_INTERVAL_MINUTES: 5 },
      logger: t.services.logger,
    });
    expect(on.enabled).toBe(true);
    const [a, b] = await Promise.all([on.runOnce(), on.runOnce()]);
    // Overlapping calls share one evaluation.
    expect(a).toBe(b);
  });
});
