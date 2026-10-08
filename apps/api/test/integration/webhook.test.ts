import { recordExecution, type AgentDefinition } from "@shadow/core";
import type { Outcome } from "@shadow/schemas";
import { MockToolAdapter, RuleBasedPolicyAdapter, ScriptedModelAdapter } from "@shadow/testkit";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createWebhook, type Notification } from "../../src/notify/webhook.js";
import { createLogger } from "../../src/logger.js";
import { createDefaultRegistry } from "../../src/replay/registry.js";
import {
  BASE_TIME,
  createTestApp,
  findEvent,
  ingestRefundScenario,
  json,
  type TestApp,
} from "../helpers.js";

const received: Notification[] = [];
let t: TestApp;

/** Calls different tools on its second run, so a deterministic replay cannot reproduce the prefix. */
let runs = 0;
const fickleAgent: AgentDefinition = {
  slug: "fickle-agent",
  name: "Fickle Agent",
  createAdapters: () => ({
    model: new ScriptedModelAdapter({}),
    tools: new MockToolAdapter({
      ping: () => ({ result: "pong" }),
      pong: () => ({ result: "ping" }),
      other: () => ({ result: "?" }),
    }),
    policies: new RuleBasedPolicyAdapter({}),
  }),
  async program(host): Promise<Outcome> {
    runs++;
    await host.tool({ name: runs === 1 ? "ping" : "other", arguments: {} });
    await host.tool({ name: "pong", arguments: {} });
    return { kind: "completed", label: "Done" };
  },
};

beforeAll(async () => {
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    received.push(JSON.parse(String(init?.body)) as Notification);
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
  const registry = createDefaultRegistry();
  registry.register(fickleAgent);
  t = await createTestApp({ registry });
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
    expect(notification?.type === "trace.finished" ? notification.trace.completedAt : "").toMatch(
      /^2026-/,
    );

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

  it("notifies when a replay fails, regardless of the event filter", async () => {
    const traceId = "trc_webhook_fickle";
    const recorded = await recordExecution({
      definition: fickleAgent,
      input: {},
      traceId,
      branchId: "br_webhook_fickle",
      traceName: "fickle run",
      seed: "fickle",
      startAt: BASE_TIME,
    });
    expect(recorded.status).toBe("completed");
    const created = await t.app.inject({
      method: "POST",
      url: "/api/v1/traces",
      payload: { id: traceId, project: "lab", agent: fickleAgent.slug, name: "fickle run" },
    });
    expect(created.statusCode).toBe(201);
    const ingested = await t.app.inject({
      method: "POST",
      url: `/api/v1/traces/${traceId}/events`,
      payload: { events: recorded.events },
    });
    expect(ingested.statusCode).toBe(201);
    await t.services.webhook.settle();
    // A completed trace is outside the policy_violations filter.
    expect(received).toHaveLength(1);

    const forkEvent = findEvent(recorded.events, "tool.request", "pong");
    const forked = await t.app.inject({
      method: "POST",
      url: `/api/v1/traces/${traceId}/forks`,
      payload: {
        forkEventId: forkEvent.id,
        name: "what if pong said ping",
        overrides: [{ kind: "tool_result", tool: "pong", occurrence: 1, result: "ping!" }],
      },
    });
    expect(forked.statusCode, forked.body).toBe(201);
    const { branch } = json<{ branch: { id: string } }>(forked);
    const replayed = await t.app.inject({
      method: "POST",
      url: `/api/v1/branches/${branch.id}/replay`,
    });
    expect(replayed.statusCode, replayed.body).toBe(201);
    const { replay } = json<{ replay: { id: string; status: string; error: string | null } }>(
      replayed,
    );
    expect(replay.status).toBe("failed");
    await t.services.webhook.settle();
    expect(received).toHaveLength(2);
    expect(received[1]).toMatchObject({
      type: "replay.failed",
      replay: { id: replay.id, mode: "deterministic", error: replay.error },
      trace: { id: traceId, name: "fickle run", projectSlug: "lab", agentSlug: "fickle-agent" },
      branch: { id: branch.id, name: "what if pong said ping" },
    });
    expect(replay.error).toContain("could not reproduce");
  });
});
