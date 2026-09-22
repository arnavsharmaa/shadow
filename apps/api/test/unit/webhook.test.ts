import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createLogger } from "../../src/logger.js";
import { classify, createWebhook, sign } from "../../src/notify/webhook.js";

const logger = createLogger({ level: "silent" });
const trace = {
  id: "trc_1",
  name: "refund",
  projectSlug: "p",
  agentSlug: "a",
  status: "failed" as const,
  outcome: { kind: "policy_violation", label: "Policy violation" },
  startedAt: "2026-09-01T09:00:00.000Z",
  completedAt: "2026-09-01T09:00:05.000Z",
  tags: ["refund"],
};

describe("webhook", () => {
  it("classifies finished traces against the event filter", () => {
    expect(classify("failures", { status: "failed", outcome: null })).toBe("failed");
    expect(classify("failures", { status: "completed", outcome: null })).toBeNull();
    expect(classify("failures", { status: "failed", outcome: trace.outcome })).toBe(
      "policy_violation",
    );
    expect(classify("policy_violations", { status: "failed", outcome: null })).toBeNull();
    expect(classify("policy_violations", { status: "completed", outcome: trace.outcome })).toBe(
      "policy_violation",
    );
    expect(classify("all", { status: "completed", outcome: null })).toBe("all");
  });

  it("posts a signed JSON body and retries server errors", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    let attempt = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      attempt++;
      return new Response(attempt === 1 ? "busy" : "ok", { status: attempt === 1 ? 503 : 200 });
    }) as unknown as typeof fetch;
    const webhook = createWebhook({
      config: {
        SHADOW_WEBHOOK_URL: "https://hooks.example.com/shadow",
        SHADOW_WEBHOOK_SECRET: "s3cret",
        SHADOW_WEBHOOK_EVENTS: "failures",
      },
      logger,
      fetch: fetchImpl,
      backoffMs: 1,
    });
    expect(webhook.enabled).toBe(true);
    await webhook.traceFinished({ trace });
    await webhook.settle();
    expect(calls).toHaveLength(2);
    const { url, init } = calls[1] as { url: string; init: RequestInit };
    expect(url).toBe("https://hooks.example.com/shadow");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-shadow-event"]).toBe("trace.finished");
    expect(headers["x-shadow-delivery"]).toMatch(/^trc_1:/);
    const body = JSON.parse(String(init.body)) as {
      type: string;
      reason: string;
      trace: { id: string };
    };
    expect(body.type).toBe("trace.finished");
    expect(body.reason).toBe("policy_violation");
    expect(body.trace.id).toBe("trc_1");
    const expected = `sha256=${createHmac("sha256", "s3cret").update(String(init.body)).digest("hex")}`;
    expect(headers["x-shadow-signature-256"]).toBe(expected);
    expect(sign("s3cret", String(init.body))).toBe(expected);
  });

  it("does not retry client rejections, skips filtered traces and never throws", async () => {
    const rejected = vi.fn(
      async () => new Response("nope", { status: 400 }),
    ) as unknown as typeof fetch;
    const webhook = createWebhook({
      config: {
        SHADOW_WEBHOOK_URL: "https://hooks.example.com/x",
        SHADOW_WEBHOOK_SECRET: undefined,
        SHADOW_WEBHOOK_EVENTS: "failures",
      },
      logger,
      fetch: rejected,
      backoffMs: 1,
    });
    await webhook.traceFinished({ trace });
    expect(rejected).toHaveBeenCalledTimes(1);
    await webhook.traceFinished({ trace: { ...trace, status: "completed", outcome: null } });
    expect(rejected).toHaveBeenCalledTimes(1);

    const broken = vi.fn(async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    const failing = createWebhook({
      config: {
        SHADOW_WEBHOOK_URL: "https://hooks.example.com/x",
        SHADOW_WEBHOOK_SECRET: undefined,
        SHADOW_WEBHOOK_EVENTS: "all",
      },
      logger,
      fetch: broken,
      maxAttempts: 2,
      backoffMs: 1,
    });
    await expect(failing.traceFinished({ trace })).resolves.toBeUndefined();
    expect(broken).toHaveBeenCalledTimes(2);

    const off = createWebhook({
      config: {
        SHADOW_WEBHOOK_URL: undefined,
        SHADOW_WEBHOOK_SECRET: undefined,
        SHADOW_WEBHOOK_EVENTS: "all",
      },
      logger,
      fetch: broken,
    });
    expect(off.enabled).toBe(false);
    await off.traceFinished({ trace });
    expect(broken).toHaveBeenCalledTimes(2);
  });
});
