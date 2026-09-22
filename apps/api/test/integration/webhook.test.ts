import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createWebhook, type TraceFinishedNotification } from "../../src/notify/webhook.js";
import { createLogger } from "../../src/logger.js";
import { createTestApp, ingestRefundScenario, type TestApp } from "../helpers.js";

const received: TraceFinishedNotification[] = [];
let t: TestApp;

beforeAll(async () => {
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    received.push(JSON.parse(String(init?.body)) as TraceFinishedNotification);
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
  t = await createTestApp();
  // Swap in a live webhook after construction so the service context stays otherwise standard.
  t.services.webhook = createWebhook({
    config: {
      SHADOW_WEBHOOK_URL: "https://hooks.example.com/shadow",
      SHADOW_WEBHOOK_SECRET: undefined,
      SHADOW_WEBHOOK_EVENTS: "policy_violations",
    },
    logger: createLogger({ level: "silent" }),
    fetch: fetchImpl,
  });
});

afterAll(async () => {
  await t.close();
});

describe("webhook on ingestion", () => {
  it("notifies once a root branch finishes with a policy violation", async () => {
    const scenario = await ingestRefundScenario(t, "trc_webhook");
    await t.services.webhook.settle();
    expect(received).toHaveLength(1);
    const [notification] = received;
    expect(notification).toMatchObject({
      type: "trace.finished",
      reason: "policy_violation",
      trace: {
        id: scenario.traceId,
        agentSlug: "refund-agent",
        projectSlug: "support-agent",
        status: "failed",
        outcome: { kind: "policy_violation" },
      },
    });
    expect(notification?.trace.completedAt).toMatch(/^2026-/);

    // A trace that completes normally does not match the policy_violations filter.
    const plain = await t.app.inject({
      method: "POST",
      url: "/api/v1/traces",
      payload: { project: "p", agent: "a", name: "plain" },
    });
    const { id } = plain.json() as { id: string };
    await t.app.inject({
      method: "POST",
      url: `/api/v1/traces/${id}/events`,
      payload: {
        events: [
          { eventType: "trace.started", name: "trace.started" },
          {
            eventType: "trace.completed",
            name: "trace.completed",
            output: { outcome: { kind: "completed", label: "Done" } },
          },
        ],
      },
    });
    await t.services.webhook.settle();
    expect(received).toHaveLength(1);
  });
});
