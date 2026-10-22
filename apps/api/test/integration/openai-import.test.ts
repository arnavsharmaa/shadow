import type { AuditEntry, Branch, ShadowEvent, TraceSummary } from "@shadow/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpenAIImportResult } from "../../src/importers/import-openai.js";
import { openAIRefundConversationJson } from "../fixtures/openai.js";
import { createTestApp, json, listAllEvents, type TestApp } from "../helpers.js";

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await t.close();
});

describe("POST /api/v1/import/openai", () => {
  it("stores a Chat Completions conversation as an inspectable trace", async () => {
    const response = await t.app.inject({
      method: "POST",
      url: "/api/v1/import/openai",
      headers: { "x-shadow-actor": "arnav" },
      payload: { ...openAIRefundConversationJson(), traceId: "trc_openai_refund" },
    });
    expect(response.statusCode, response.body).toBe(201);
    const result = json<OpenAIImportResult>(response);
    expect(result).toMatchObject({
      traceId: "trc_openai_refund",
      name: "ticket-1234: defective headphones",
      events: 24,
      summary: { turns: 3, toolCalls: 2, finishReason: "stop" },
    });

    const detail = json<{ trace: TraceSummary; branches: Branch[] }>(
      await t.app.inject({ url: "/api/v1/traces/trc_openai_refund" }),
    );
    expect(detail.trace).toMatchObject({
      projectSlug: "support",
      agentSlug: "gpt-refund-agent",
      status: "completed",
      outcome: { kind: "completed" },
      tags: ["openai", "refund"],
      metadata: { openai: { model: "gpt-5", turns: 3 } },
    });
    expect(detail.trace.metrics).toMatchObject({
      modelCalls: 3,
      toolCalls: 2,
      toolErrors: 1,
      inputTokens: 1145,
      outputTokens: 103,
      totalTokens: 1248,
    });
    // gpt-5 is in the built-in catalog: 1145 input tokens at $1.25/M, of which 256 cached at
    // $0.125/M, plus 103 output tokens at $10/M.
    expect(detail.trace.metrics.totalEstimatedCost).toBeCloseTo(0.00217325, 8);
    const events = await listAllEvents(t, "trc_openai_refund");
    expect(events).toHaveLength(24);
    expect(events.every((e: ShadowEvent) => e.source === "openai")).toBe(true);
    const state = json<{ state: { messages: unknown[] } }>(
      await t.app.inject({
        url: `/api/v1/branches/${detail.trace.rootBranchId}/state`,
      }),
    );
    expect(state.state.messages).toHaveLength(7);

    const log = json<{ items: AuditEntry[] }>(
      await t.app.inject({ url: "/api/v1/audit?action=trace.imported" }),
    );
    expect(log.items[0]).toMatchObject({
      actor: "arnav",
      targetId: "trc_openai_refund",
      details: { format: "openai.chat", turns: 3 },
    });
  });

  it("defaults the project, pins to an ingest key's project and rejects malformed bodies", async () => {
    const bare = await t.app.inject({
      method: "POST",
      url: "/api/v1/import/openai",
      payload: { messages: [{ role: "user", content: "hello" }] },
    });
    expect(bare.statusCode).toBe(201);
    const { traceId } = json<OpenAIImportResult>(bare);
    const detail = json<{ trace: TraceSummary }>(
      await t.app.inject({ url: `/api/v1/traces/${traceId}` }),
    );
    expect(detail.trace).toMatchObject({ projectSlug: "openai", agentSlug: "gpt-agent" });

    expect(
      (
        await t.app.inject({
          method: "POST",
          url: "/api/v1/import/openai",
          payload: { messages: [] },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await t.app.inject({
          method: "POST",
          url: "/api/v1/import/openai",
          payload: { messages: [{ role: "wizard", content: "x" }] },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await t.app.inject({
          method: "POST",
          url: "/api/v1/import/openai",
          payload: { ...openAIRefundConversationJson(), traceId: "trc_openai_refund" },
        })
      ).statusCode,
    ).toBe(409);
  });
});
