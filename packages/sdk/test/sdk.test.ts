import { describe, expect, it, vi } from "vitest";
import {
  HttpTransport,
  MemoryTransport,
  PolicyBlocked,
  Shadow,
  ToolError,
  TransportError,
} from "../src/index.js";

function client(
  transport: MemoryTransport,
  extra: Partial<ConstructorParameters<typeof Shadow>[0]> = {},
) {
  return new Shadow({
    project: "support-agent",
    agent: "refund-agent",
    transport,
    flushIntervalMs: 0,
    ...extra,
  });
}

describe("Shadow SDK", () => {
  it("records a complete trace with ordered sequences", async () => {
    const transport = new MemoryTransport();
    const shadow = client(transport);
    const trace = shadow.startTrace({
      name: "refund-request",
      metadata: { customerId: "cus_1" },
      tags: ["demo"],
    });
    trace.context.set("refundLimit", 500);
    trace.state.set("/step", "lookup");
    const result = await trace.tool({
      name: "search_orders",
      arguments: { customerId: "cus_1" },
      execute: async (args) => ({
        result: {
          orders: [{ id: "ord_1", customerId: (args as { customerId: string }).customerId }],
        },
        latencyMs: 5,
      }),
    });
    expect(result).toEqual({ orders: [{ id: "ord_1", customerId: "cus_1" }] });
    await trace.model({
      provider: "test",
      model: "test-1",
      name: "decide",
      messages: [{ role: "user", content: "refund?" }],
      execute: async () => ({
        message: { role: "assistant", content: "yes" },
        tokenUsage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
        estimatedCost: 0.001,
      }),
    });
    trace.snapshot();
    await trace.end({ outcome: { kind: "refunded", label: "Refund issued" } });

    expect(transport.traces[0]).toMatchObject({
      id: trace.id,
      project: "support-agent",
      agent: "refund-agent",
      name: "refund-request",
    });
    const events = transport.eventsFor(trace.id);
    const sequences = events.map((e) => e.sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => (a as number) - (b as number)));
    expect(events.map((e) => e.eventType)).toEqual([
      "trace.started",
      "agent.started",
      "context.added",
      "state.patch",
      "tool.request",
      "tool.response",
      "model.request",
      "model.response",
      "state.snapshot",
      "agent.completed",
      "trace.completed",
    ]);
    const response = events.find((e) => e.eventType === "tool.response");
    expect(response?.parentEventId).toBe(events.find((e) => e.eventType === "tool.request")?.id);
    expect(response?.durationMs).toBeGreaterThanOrEqual(0);
    const modelResponse = events.find((e) => e.eventType === "model.response");
    expect(modelResponse?.tokenUsage).toEqual({ inputTokens: 5, outputTokens: 1, totalTokens: 6 });
    expect(modelResponse?.estimatedCost).toMatchObject({ amount: 0.001, provider: "test" });
    const snapshot = events.find((e) => e.eventType === "state.snapshot");
    expect(snapshot?.output).toEqual({ state: { step: "lookup" }, context: { refundLimit: 500 } });
  });

  it("records tool errors and rethrows a ToolError", async () => {
    const transport = new MemoryTransport();
    const trace = client(transport).startTrace({ name: "t" });
    await expect(
      trace.tool({
        name: "inventory.lookup",
        arguments: {},
        execute: async () => {
          throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
        },
      }),
    ).rejects.toBeInstanceOf(ToolError);
    await trace.fail(new Error("gave up"));
    const events = transport.eventsFor(trace.id);
    expect(events.find((e) => e.eventType === "tool.error")?.output).toEqual({
      error: { message: "timeout", code: "ETIMEDOUT" },
    });
    expect(events.at(-1)?.eventType).toBe("trace.failed");
  });

  it("evaluates guard policies inside the tool span and blocks execution", async () => {
    const transport = new MemoryTransport();
    const trace = client(transport).startTrace({ name: "t" });
    const execute = vi.fn(async () => ({ ok: true }));
    await expect(
      trace.tool({
        name: "refund_order",
        arguments: { amount: 480 },
        guard: {
          policy: "refund.limit",
          subject: { amount: 480 },
          evaluate: () => ({ decision: "approval_required", reason: "too large" }),
        },
        execute,
      }),
    ).rejects.toBeInstanceOf(PolicyBlocked);
    expect(execute).not.toHaveBeenCalled();
    const approval = await trace.requestApproval({ reason: "too large" });
    expect(approval.decision).toBe("pending");
    trace.resolveApproval(approval.approvalId, "approved", "lead@example.com");
    await trace.end();
    const types = transport.eventsFor(trace.id).map((e) => e.eventType);
    expect(types).toContain("policy.evaluated");
    expect(types).toContain("policy.approval_required");
    expect(types).toContain("human.approval_requested");
    expect(types).toContain("human.approval_resolved");
    const error = transport.eventsFor(trace.id).find((e) => e.eventType === "tool.error");
    expect((error?.output as { error: { code: string } }).error.code).toBe("policy_blocked");
  });

  it("redacts sensitive keys before buffering", async () => {
    const transport = new MemoryTransport();
    const trace = client(transport).startTrace({ name: "t" });
    await trace.tool({
      name: "login",
      arguments: { user: "a", password: "hunter2", nested: { apiKey: "sk-123" } },
      execute: async () => ({ token: "abc" }),
    });
    await trace.end();
    const request = transport.eventsFor(trace.id).find((e) => e.eventType === "tool.request");
    expect(request?.input).toEqual({
      tool: "login",
      arguments: { user: "a", password: "[REDACTED]", nested: { apiKey: "[REDACTED]" } },
    });
    const response = transport.eventsFor(trace.id).find((e) => e.eventType === "tool.response");
    expect(response?.output).toEqual({ result: { token: "[REDACTED]" } });
  });

  it("runs a program and records its outcome and input", async () => {
    const transport = new MemoryTransport();
    const trace = client(transport).startTrace({ name: "t" });
    const outcome = await trace.run(
      async (host, input) => {
        host.context.set("customerId", (input as { customerId: string }).customerId);
        return { kind: "answered", label: "Done" };
      },
      { customerId: "cus_9" },
    );
    expect(outcome).toEqual({ kind: "answered", label: "Done" });
    const started = transport.eventsFor(trace.id).find((e) => e.eventType === "agent.started");
    expect(started?.input).toEqual({ agent: "refund-agent", request: { customerId: "cus_9" } });
  });

  it("never throws into agent code when the transport fails", async () => {
    const errors: Error[] = [];
    const failing = {
      createTrace: async () => {
        throw new Error("connection refused");
      },
      sendEvents: async () => undefined,
    };
    const shadow = new Shadow({
      project: "p",
      agent: "a",
      transport: failing,
      flushIntervalMs: 0,
      onError: (e) => errors.push(e),
    });
    const trace = shadow.startTrace({ name: "t" });
    await trace.tool({ name: "x", arguments: null, execute: async () => 1 });
    await trace.end();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]?.message).toContain("connection refused");
  });

  it("queues artifacts and sends them after their events", async () => {
    const transport = new MemoryTransport();
    const trace = client(transport).startTrace({ name: "t" });
    await trace.tool({
      name: "send_email",
      arguments: { to: "a@example.com" },
      execute: async () => ({ status: "sent" }),
    });
    const eventId = trace.lastEventId;
    expect(eventId).toBeTruthy();
    trace.artifact({
      kind: "email",
      name: "customer-email",
      content: { subject: "Hi", apiKey: "sk-secret" },
      eventId: eventId ?? undefined,
    });
    await trace.end();
    const artifacts = transport.artifactsFor(trace.id);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      kind: "email",
      name: "customer-email",
      contentType: "application/json",
      eventId,
    });
    expect(artifacts[0]?.content).toEqual({ subject: "Hi", apiKey: "[REDACTED]" });
  });

  it("coalesces tag and metadata updates and sends them after events", async () => {
    const transport = new MemoryTransport();
    const trace = client(transport).startTrace({ name: "t", tags: ["refund"] });
    trace.tag("triaged", " escalated ", "");
    trace.untag("refund", "triaged");
    trace.tag("triaged");
    trace.setMetadata({ owner: "jordan", apiKey: "sk-1", stale: null, skipped: undefined });
    await trace.tool({ name: "x", arguments: null, execute: async () => 1 });
    await trace.end();
    expect(transport.updatesFor(trace.id)).toEqual([
      {
        addTags: ["escalated", "triaged"],
        removeTags: ["refund"],
        metadata: { owner: "jordan", apiKey: "[REDACTED]", stale: null },
      },
    ]);
    expect(transport.eventsFor(trace.id).length).toBeGreaterThan(0);

    const quiet = new MemoryTransport();
    const untouched = client(quiet).startTrace({ name: "t" });
    await untouched.end();
    expect(quiet.updatesFor(untouched.id)).toEqual([]);
  });

  it("sends labels applied after the trace ended", async () => {
    const transport = new MemoryTransport();
    const trace = client(transport).startTrace({ name: "t" });
    const outcome = await trace.run(async () => ({ kind: "refunded", label: "Refund issued" }), {});
    trace.tag(`outcome:${outcome?.kind ?? "unknown"}`);
    trace.setMetadata({ outcomeLabel: outcome?.label ?? null });
    await trace.flush();
    // Both labels land before the scheduled flush runs, so they travel as one update.
    expect(transport.updatesFor(trace.id)).toEqual([
      { addTags: ["outcome:refunded"], metadata: { outcomeLabel: "Refund issued" } },
    ]);
  });

  it("HttpTransport sends trace updates as PATCH requests", async () => {
    const calls: { url: string; method?: string; body?: unknown }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ id: "trc_1", tags: ["a"] }), { status: 200 });
    }) as unknown as typeof fetch;
    const transport = new HttpTransport({ endpoint: "http://shadow.test", fetch: fetchImpl });
    const updated = await transport.updateTrace("trc_1", { addTags: ["a"] });
    expect(updated.tags).toEqual(["a"]);
    expect(calls[0]).toEqual({
      url: "http://shadow.test/api/v1/traces/trc_1",
      method: "PATCH",
      body: { addTags: ["a"] },
    });
  });

  it("discards everything when recording is disabled", async () => {
    const transport = new MemoryTransport();
    const shadow = new Shadow({
      project: "p",
      agent: "a",
      transport,
      enabled: false,
      flushIntervalMs: 0,
    });
    expect(shadow.enabled).toBe(false);
    const trace = shadow.startTrace({ name: "t" });
    await trace.tool({ name: "x", arguments: null, execute: async () => 1 });
    await trace.end();
    expect(transport.traces).toHaveLength(0);
  });

  it("forwards a bearer token through the HTTP transport", async () => {
    const seen: Record<string, string>[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      seen.push((init?.headers ?? {}) as Record<string, string>);
      return new Response(JSON.stringify({ id: "trc_1", rootBranchId: "br_1" }), { status: 201 });
    }) as unknown as typeof fetch;
    const transport = new HttpTransport({
      endpoint: "http://shadow.test",
      fetch: fetchImpl,
      headers: { authorization: "Bearer tok" },
    });
    await transport.createTrace({ project: "p", agent: "a", name: "n" });
    expect(seen[0]?.authorization).toBe("Bearer tok");
  });

  it("HttpTransport retries 5xx responses and surfaces 4xx errors", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
      calls++;
      if (calls === 1) return new Response("oops", { status: 503 });
      return new Response(JSON.stringify({ id: "trc_1", rootBranchId: "br_1" }), { status: 201 });
    });
    const transport = new HttpTransport({
      endpoint: "http://shadow.test/",
      fetch: fetchImpl as unknown as typeof fetch,
      backoffMs: 1,
    });
    const handle = await transport.createTrace({ project: "p", agent: "a", name: "n" });
    expect(handle).toEqual({ id: "trc_1", rootBranchId: "br_1" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://shadow.test/api/v1/traces");

    const bad = new HttpTransport({
      endpoint: "http://shadow.test",
      fetch: (async () =>
        new Response(JSON.stringify({ error: { code: "validation_error" } }), {
          status: 400,
        })) as unknown as typeof fetch,
      backoffMs: 1,
    });
    await expect(bad.sendEvents("trc_1", [])).rejects.toBeInstanceOf(TransportError);
  });
});
