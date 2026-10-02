import { VirtualClock } from "@shadow/core";
import type { AlertRule } from "@shadow/schemas";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createLogger } from "../../src/logger.js";
import { createWebhook, type AlertNotification } from "../../src/notify/webhook.js";
import type { AlertEvaluation } from "../../src/services/alerts.js";
import { createTestApp, json, type TestApp } from "../helpers.js";

const NOW = Date.parse("2026-09-08T10:00:00.000Z");
const HOUR = 3_600_000;
const clock = new VirtualClock(NOW);
const received: AlertNotification[] = [];
let t: TestApp;

/** One finished run of `agent`, started `hoursAgo` hours before now, with tool errors. */
async function run(agent: string, hoursAgo: number, toolErrors: number, failed = false) {
  const created = await t.app.inject({
    method: "POST",
    url: "/api/v1/traces",
    payload: {
      project: "p",
      agent,
      name: `${agent} -${hoursAgo}h`,
      startedAt: new Date(NOW - hoursAgo * HOUR).toISOString(),
    },
  });
  const { id } = json<{ id: string }>(created);
  // The lifecycle events carry the run's own time; without it they would be stamped "now".
  const at = (offsetMs: number) => new Date(NOW - hoursAgo * HOUR + offsetMs).toISOString();
  const events: Record<string, unknown>[] = [
    { eventType: "trace.started", name: "trace.started", timestamp: at(0) },
  ];
  for (let i = 0; i < toolErrors; i++) {
    events.push(
      { eventType: "tool.request", name: "call_api", spanId: `spn_${i}`, timestamp: at(i + 1) },
      {
        eventType: "tool.error",
        name: "call_api",
        spanId: `spn_${i}`,
        timestamp: at(i + 2),
        severity: "error",
        output: { error: { message: "timeout" } },
      },
    );
  }
  events.push(
    failed
      ? {
          eventType: "trace.failed",
          name: "trace.failed",
          timestamp: at(1000),
          output: { error: { message: "x" } },
        }
      : {
          eventType: "trace.completed",
          name: "trace.completed",
          timestamp: at(1000),
          output: { outcome: { kind: "completed", label: "Done" } },
        },
  );
  const ingested = await t.app.inject({
    method: "POST",
    url: `/api/v1/traces/${id}/events`,
    payload: { events },
  });
  expect(ingested.statusCode, ingested.body).toBe(201);
}

async function createRule(body: Record<string, unknown>): Promise<AlertRule> {
  const response = await t.app.inject({
    method: "POST",
    url: "/api/v1/alerts/rules",
    payload: body,
  });
  expect(response.statusCode, response.body).toBe(201);
  return json<AlertRule>(response);
}

async function evaluate(): Promise<Map<string, AlertEvaluation>> {
  const response = await t.app.inject({ method: "POST", url: "/api/v1/alerts/evaluate" });
  await t.services.webhook.settle();
  return new Map(json<{ items: AlertEvaluation[] }>(response).items.map((e) => [e.rule.name, e]));
}

beforeAll(async () => {
  t = await createTestApp({ clock });
  t.services.webhook = createWebhook({
    config: {
      SHADOW_WEBHOOK_URL: "https://hooks.example.com/shadow",
      SHADOW_WEBHOOK_SECRET: undefined,
      SHADOW_WEBHOOK_EVENTS: "failures",
    },
    logger: createLogger({ level: "silent" }),
    fetch: vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { type: string };
      if (body.type.startsWith("alert.")) received.push(body as AlertNotification);
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch,
  });
  // Baseline: one run with one tool error in each of the four hours before the current one,
  // one of them failed. Current hour: one failed run with three tool errors.
  await run("flaky", 4.5, 1);
  await run("flaky", 3.5, 1, true);
  await run("flaky", 2.5, 1);
  await run("flaky", 1.5, 1);
  await run("flaky", 0.5, 3, true);
  // An agent with no history before the current hour.
  await run("newcomer", 0.5, 5, true);
  received.length = 0;
});

afterAll(async () => {
  await t.close();
});

describe("baseline alert rules", () => {
  it("fire when a metric is a multiple of its own recent baseline", async () => {
    const errors = await createRule({
      name: "flaky tool errors",
      agent: "flaky",
      metric: "tool_errors",
      mode: "baseline",
      threshold: 2,
      baselineWindows: 4,
      windowMinutes: 60,
    });
    expect(errors).toMatchObject({ mode: "baseline", baselineWindows: 4, lastBaseline: null });
    await createRule({
      name: "flaky failure rate",
      agent: "flaky",
      metric: "failure_rate",
      mode: "baseline",
      threshold: 3,
      baselineWindows: 4,
      windowMinutes: 60,
    });
    await createRule({
      name: "flaky errors, 5x",
      agent: "flaky",
      metric: "tool_errors",
      mode: "baseline",
      threshold: 5,
      baselineWindows: 4,
      windowMinutes: 60,
    });
    await createRule({
      name: "newcomer errors",
      agent: "newcomer",
      metric: "tool_errors",
      mode: "baseline",
      threshold: 2,
      windowMinutes: 60,
    });

    const result = await evaluate();
    // Sums are averaged per baseline window: 4 errors over 4 hours is 1 per hour; now 3.
    expect(result.get("flaky tool errors")).toMatchObject({
      transition: "fired",
      rule: { state: "firing", lastValue: 3, lastBaseline: 1, lastTraces: 1 },
    });
    // Rates are taken over the whole baseline: 1 of 4 failed (0.25); now 1 of 1, which is 4x.
    expect(result.get("flaky failure rate")).toMatchObject({
      transition: "fired",
      rule: { lastValue: 1, lastBaseline: 0.25 },
    });
    // 3 is not 5 times the baseline.
    expect(result.get("flaky errors, 5x")).toMatchObject({
      transition: "none",
      rule: { state: "ok", lastBaseline: 1 },
    });
    // No history means nothing to compare against, however bad the current window looks.
    expect(result.get("newcomer errors")).toMatchObject({
      transition: "none",
      rule: { state: "ok", lastValue: 5, lastBaseline: null, baselineWindows: 7 },
    });

    expect(received.map((n) => [n.type, n.rule.name, n.rule.mode, n.value, n.baseline])).toEqual([
      ["alert.firing", "flaky failure rate", "baseline", 1, 0.25],
      ["alert.firing", "flaky tool errors", "baseline", 3, 1],
    ]);

    // An hour later the bad run is part of the baseline and the current window is empty.
    clock.advance(HOUR);
    const later = await evaluate();
    expect(later.get("flaky tool errors")).toMatchObject({
      transition: "resolved",
      rule: { state: "ok", lastValue: 0, lastTraces: 0 },
    });
    expect(later.get("flaky tool errors")?.rule.lastBaseline).toBeCloseTo(6 / 4, 5);
  });

  it("validates multipliers and the total look-back", async () => {
    const tooLow = await t.app.inject({
      method: "POST",
      url: "/api/v1/alerts/rules",
      payload: { name: "bad", metric: "tool_errors", mode: "baseline", threshold: 1 },
    });
    expect(tooLow.statusCode).toBe(400);
    const tooLong = await t.app.inject({
      method: "POST",
      url: "/api/v1/alerts/rules",
      payload: {
        name: "bad",
        metric: "tool_errors",
        mode: "baseline",
        threshold: 2,
        windowMinutes: 43_200,
        baselineWindows: 7,
      },
    });
    expect(tooLong.statusCode).toBe(400);
    // In baseline mode a failure_rate multiplier may exceed 1.
    const rate = await createRule({
      name: "rate multiple",
      metric: "failure_rate",
      mode: "baseline",
      threshold: 2.5,
    });
    const lowered = await t.app.inject({
      method: "PATCH",
      url: `/api/v1/alerts/rules/${rate.id}`,
      payload: { threshold: 0.5 },
    });
    expect(lowered.statusCode).toBe(400);
    const stretched = await t.app.inject({
      method: "PATCH",
      url: `/api/v1/alerts/rules/${rate.id}`,
      payload: { windowMinutes: 43_200 },
    });
    expect(stretched.statusCode).toBe(400);
    const fine = await t.app.inject({
      method: "PATCH",
      url: `/api/v1/alerts/rules/${rate.id}`,
      payload: { baselineWindows: 14, threshold: 3 },
    });
    expect(json<AlertRule>(fine)).toMatchObject({ baselineWindows: 14, threshold: 3 });
  });
});
