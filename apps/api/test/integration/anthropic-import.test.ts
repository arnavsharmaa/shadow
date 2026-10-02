import type { AuditEntry, Branch, ShadowEvent, TraceSummary } from "@shadow/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AnthropicImportResult } from "../../src/importers/import-anthropic.js";
import { refundConversationJson } from "../fixtures/anthropic.js";
import { createTestApp, json, listAllEvents, type TestApp } from "../helpers.js";

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await t.close();
});

describe("POST /api/v1/import/anthropic", () => {
  it("stores a Messages API conversation as an inspectable trace", async () => {
    const response = await t.app.inject({
      method: "POST",
      url: "/api/v1/import/anthropic",
      headers: { "x-shadow-actor": "arnav" },
      payload: { ...refundConversationJson(), traceId: "trc_anthropic_refund" },
    });
    expect(response.statusCode, response.body).toBe(201);
    const result = json<AnthropicImportResult>(response);
    expect(result).toMatchObject({
      traceId: "trc_anthropic_refund",
      name: "ticket-1234: defective headphones",
      events: 26,
      summary: { turns: 3, toolCalls: 2, serverToolCalls: 1, stopReason: "end_turn" },
    });

    const detail = json<{ trace: TraceSummary; branches: Branch[] }>(
      await t.app.inject({ url: "/api/v1/traces/trc_anthropic_refund" }),
    );
    expect(detail.trace).toMatchObject({
      projectSlug: "support",
      agentSlug: "claude-refund-agent",
      status: "completed",
      startedAt: "2026-09-30T09:00:00.000Z",
      tags: ["anthropic", "refund"],
      outcome: { kind: "completed", label: "Completed" },
    });
    expect(detail.trace.metrics).toMatchObject({
      eventCount: 26,
      modelCalls: 3,
      toolCalls: 3,
      toolErrors: 1,
      inputTokens: 1660,
      outputTokens: 173,
      totalTokens: 1833,
    });
    // Priced from the built-in Anthropic table: cache reads at the cache rate.
    expect(detail.trace.metrics.totalEstimatedCost).toBeCloseTo(0.0065128, 7);

    const events = await listAllEvents(t, "trc_anthropic_refund");
    expect(events.every((e: ShadowEvent) => e.source === "anthropic")).toBe(true);
    expect(
      events.find((e: ShadowEvent) => e.eventType === "model.response" && e.name === "turn-2")
        ?.estimatedCost,
    ).toEqual({
      amount: 0.0024264,
      currency: "USD",
      provider: "anthropic",
      model: "claude-opus-5-5",
      pricingVersion: "anthropic-2026-09-25",
    });
    expect(events.map((e: ShadowEvent) => e.sequence)).toEqual([...events.keys()]);

    // Token counts in metadata survive server-side redaction.
    expect(
      events.find((e: ShadowEvent) => e.eventType === "model.response" && e.name === "turn-2")
        ?.metadata,
    ).toEqual({
      anthropic: { responseId: "msg_01b", usage: { cache_creation_input_tokens: 120 } },
    });

    // The conversation is the trace's state, and the system prompt its context.
    const state = json<{
      state: { messages: { role: string }[] };
      context: Record<string, unknown>;
    }>(await t.app.inject({ url: `/api/v1/branches/${detail.trace.rootBranchId}/state` }));
    expect(state.state.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(state.context.system).toContain("customer-support agent");
    expect(state.context.tools).toEqual(["lookup_order", "refund_order", "web_search"]);

    // State as of the failed refund: four messages so far.
    const refundError = events.find((e: ShadowEvent) => e.eventType === "tool.error");
    const before = json<{ state: { messages: unknown[] } }>(
      await t.app.inject({
        url: `/api/v1/branches/${detail.trace.rootBranchId}/state?eventId=${refundError?.id}`,
      }),
    );
    expect(before.state.messages).toHaveLength(4);

    // Tool spans nest under the agent span in the execution tree.
    const tree = json<{ nodes: { id: string; depth: number }[] }>(
      await t.app.inject({ url: "/api/v1/traces/trc_anthropic_refund/tree" }),
    );
    const depth = (type: string) =>
      tree.nodes.find((n) => n.id === events.find((e: ShadowEvent) => e.eventType === type)?.id)
        ?.depth;
    expect(depth("tool.request")).toBe((depth("agent.started") ?? 0) + 1);
    expect(depth("tool.response")).toBe((depth("tool.request") ?? 0) + 1);

    const log = json<{ items: AuditEntry[] }>(
      await t.app.inject({ url: "/api/v1/audit?traceId=trc_anthropic_refund" }),
    );
    expect(log.items[0]).toMatchObject({
      action: "trace.imported",
      actor: "arnav",
      details: { format: "anthropic.messages", turns: 3 },
    });
  });

  it("can be forked without replay, like other imported traces", async () => {
    const events = await listAllEvents(t, "trc_anthropic_refund");
    const refund = events.find(
      (e: ShadowEvent) => e.eventType === "tool.request" && e.name === "refund_order",
    );
    const forked = await t.app.inject({
      method: "POST",
      url: "/api/v1/traces/trc_anthropic_refund/forks",
      payload: {
        forkEventId: refund?.id,
        name: "limit-500",
        overrides: [{ kind: "context", op: "set", key: "refundLimit", value: 500 }],
      },
    });
    expect(forked.statusCode).toBe(201);
    const replay = await t.app.inject({
      method: "POST",
      url: `/api/v1/branches/${json<{ branch: Branch }>(forked).branch.id}/replay`,
    });
    expect(replay.statusCode).toBe(422);
  });

  it("rejects malformed conversations and duplicate trace ids", async () => {
    const empty = await t.app.inject({
      method: "POST",
      url: "/api/v1/import/anthropic",
      payload: { messages: [] },
    });
    expect(empty.statusCode).toBe(400);
    const badRole = await t.app.inject({
      method: "POST",
      url: "/api/v1/import/anthropic",
      payload: { messages: [{ role: "tool", content: "x" }] },
    });
    expect(badRole.statusCode).toBe(400);
    const duplicate = await t.app.inject({
      method: "POST",
      url: "/api/v1/import/anthropic",
      payload: { ...refundConversationJson(), traceId: "trc_anthropic_refund" },
    });
    expect(duplicate.statusCode).toBe(409);

    // A bare messages array body is the minimum: defaults fill in the rest.
    const minimal = await t.app.inject({
      method: "POST",
      url: "/api/v1/import/anthropic",
      payload: { messages: [{ role: "user", content: "hello" }] },
    });
    expect(minimal.statusCode).toBe(201);
    const created = json<AnthropicImportResult>(minimal);
    expect(created).toMatchObject({ name: "hello", summary: { turns: 0, stopReason: null } });
    const detail = json<{ trace: TraceSummary }>(
      await t.app.inject({ url: `/api/v1/traces/${created.traceId}` }),
    );
    expect(detail.trace).toMatchObject({
      projectSlug: "anthropic",
      agentSlug: "claude-agent",
      outcome: { kind: "incomplete" },
    });
  });
});
