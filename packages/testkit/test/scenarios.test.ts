import type { Adapters, AgentDefinition } from "@shadow/core";
import { recordExecution } from "@shadow/core";
import type { AgentHost, JsonObject, JsonValue, Outcome, ShadowEvent } from "@shadow/schemas";
import { describe, expect, it } from "vitest";
import {
  DEMO_TRACE_IDS,
  MockToolAdapter,
  RuleBasedPolicyAdapter,
  ScriptedModelAdapter,
  approvingAfter,
  asObject,
  demoTraces,
  estimateTokens,
  findScenario,
  pendingApprovals,
  scenarioDefinitions,
  syntheticAgentDefinition,
  usageFor,
  withAdapters,
  type DemoTraceSpec,
} from "../src/index.js";

function must<T>(value: T | undefined, what = "value"): T {
  if (value === undefined) throw new Error(`expected ${what}`);
  return value;
}

function record(spec: DemoTraceSpec) {
  return recordExecution({
    definition: spec.agent,
    input: spec.input,
    traceId: spec.traceId,
    branchId: spec.rootBranchId,
    traceName: spec.name,
    seed: spec.seed,
    startAt: spec.startAt,
    tags: spec.tags,
    traceMetadata: spec.metadata,
  });
}

function bySpecId(traceId: string): DemoTraceSpec {
  return must(
    demoTraces.find((s) => s.traceId === traceId),
    traceId,
  );
}

const count = (events: readonly ShadowEvent[], eventType: string, name?: string) =>
  events.filter((e) => e.eventType === eventType && (name === undefined || e.name === name)).length;

describe("demo scenarios", () => {
  it("record deterministically", async () => {
    for (const spec of demoTraces) {
      const [a, b] = await Promise.all([record(spec), record(spec)]);
      expect(a.events, spec.traceId).toEqual(b.events);
      expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
      expect(a.outcome).toEqual(b.outcome);
      expect(
        a.events.every((e) => e.traceId === spec.traceId && e.branchId === spec.rootBranchId),
      ).toBe(true);
      expect(must(a.events[0]).timestamp).toBe(spec.startAt);
    }
  });

  it("refund (violation): the agent refunds $480 autonomously and the audit denies it", async () => {
    const result = await record(bySpecId(DEMO_TRACE_IDS.refundViolation));
    expect(result.status).toBe("failed");
    expect(result.outcome?.kind).toBe("policy_violation");
    expect(count(result.events, "tool.response", "refund_order")).toBe(1);
    expect(count(result.events, "policy.denied", "compliance.refund_limit")).toBe(1);
    expect(must(result.events.at(-1)).eventType).toBe("trace.failed");
  });

  it("inventory: three timeouts, a malformed cached fallback and a wrong backorder", async () => {
    const result = await record(bySpecId(DEMO_TRACE_IDS.inventoryTimeout));
    expect(result.status).toBe("completed");
    expect(result.outcome?.kind).toBe("incorrect_action");
    expect(count(result.events, "tool.error", "inventory.lookup")).toBe(3);
    expect(count(result.events, "agent.note", "retry")).toBe(3);
    expect(count(result.events, "tool.response", "orders.create_backorder")).toBe(1);
    expect(count(result.events, "tool.request", "orders.reserve_stock")).toBe(0);
    expect(result.metrics.toolErrors).toBe(3);
  });

  it("faq: answers from the knowledge base", async () => {
    for (const id of [DEMO_TRACE_IDS.faqSuccess, DEMO_TRACE_IDS.faqSecond]) {
      const result = await record(bySpecId(id));
      expect(result.status).toBe("completed");
      expect(result.outcome?.kind).toBe("answered");
      expect(count(result.events, "tool.response", "send_reply")).toBe(1);
      expect(count(result.events, "tool.error")).toBe(0);
    }
  });

  it("enrichment: completes with six enrich_company calls (two per company)", async () => {
    const result = await record(bySpecId(DEMO_TRACE_IDS.enrichmentExpensive));
    expect(result.status).toBe("completed");
    expect(result.outcome?.kind).toBe("completed");
    expect(count(result.events, "tool.request", "enrich_company")).toBe(6);
    expect(count(result.events, "tool.request", "save_record")).toBe(3);
    expect(result.metrics.estimatedToolCost).toBeCloseTo(0.3, 8);
    expect(result.metrics.modelCalls).toBe(4);
  });

  it("access: privileged role is granted after a human approval", async () => {
    const result = await record(bySpecId(DEMO_TRACE_IDS.accessApproval));
    expect(result.status).toBe("completed");
    expect(result.outcome?.kind).toBe("granted");
    expect(count(result.events, "policy.approval_required", "access.privileged_roles")).toBe(1);
    expect(count(result.events, "tool.error", "grant_access")).toBe(1);
    expect(count(result.events, "human.approval_requested")).toBe(1);
    const resolved = result.events.filter((e) => e.eventType === "human.approval_resolved");
    expect(resolved).toHaveLength(1);
    expect(asObject(must(resolved[0]).output).decision).toBe("approved");
    expect(must(resolved[0]).durationMs).toBe(45_000);
    expect(count(result.events, "tool.response", "grant_access")).toBe(1);
  });

  it("enterprise refund: an $85 refund is within the company limit", async () => {
    const result = await record(bySpecId(DEMO_TRACE_IDS.refundEnterprise));
    expect(result.status).toBe("completed");
    expect(result.outcome?.kind).toBe("refunded");
    expect(count(result.events, "policy.allowed", "compliance.refund_limit")).toBe(1);
    expect(count(result.events, "tool.response", "refund_order")).toBe(1);
  });

  it("every spec references a registered, replayable scenario", () => {
    expect(scenarioDefinitions.map((d) => d.slug)).toEqual([
      "refund-agent",
      "inventory-agent",
      "support-faq-agent",
      "enrichment-agent",
      "access-request-agent",
    ]);
    for (const spec of demoTraces) {
      expect(findScenario(spec.agent.slug)).toBe(spec.agent);
      expect(spec.rootBranchId).toMatch(/^br_/);
      expect(spec.traceId).toMatch(/^trc_/);
    }
    expect(findScenario("nope")).toBeUndefined();
    expect(new Set(demoTraces.map((s) => s.traceId)).size).toBe(demoTraces.length);
  });
});

describe("syntheticAgentDefinition", () => {
  it("produces a large deterministic trace", async () => {
    const run = () =>
      recordExecution({
        definition: syntheticAgentDefinition,
        input: { iterations: 50 },
        traceId: "trc_synthetic",
        branchId: "br_synthetic",
        traceName: "synthetic",
        seed: "synthetic",
        startAt: "2026-01-01T00:00:00.000Z",
      });
    const [a, b] = await Promise.all([run(), run()]);
    expect(a.events.length).toBeGreaterThan(200);
    expect(a.events).toEqual(b.events);
    expect(a.status).toBe("completed");
    expect(a.outcome).toMatchObject({ kind: "completed", summary: "total=2450" });
    expect(count(a.events, "model.request")).toBe(50);
    expect(count(a.events, "tool.response", "compute")).toBe(50);
  });
});

describe("adapters", () => {
  it("ScriptedModelAdapter answers per step with deterministic token usage and latency", () => {
    const model = new ScriptedModelAdapter({
      plan: () => ({ text: "plan", toolCalls: [{ tool: "x", arguments: {} }], latencyMs: 10 }),
      default: () => ({ text: "fallback", data: { n: 1 } }),
    });
    const ctx = { context: {}, state: {}, now: 0 };
    const planned = model.complete(
      {
        provider: "p",
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        parameters: { step: "plan" },
      },
      ctx,
    );
    expect(planned.message).toEqual({ role: "assistant", content: "plan" });
    expect(planned.finishReason).toBe("tool_calls");
    expect(planned.toolCalls).toEqual([{ tool: "x", arguments: {} }]);
    expect(planned.latencyMs).toBe(10);
    expect(planned.tokenUsage).toEqual(
      usageFor({ provider: "p", model: "m", messages: [{ role: "user", content: "hi" }] }, "plan"),
    );

    const fallback = model.complete({ provider: "p", model: "m", messages: [] }, ctx);
    expect(fallback.message.content).toEqual({ text: "fallback", data: { n: 1 } });
    expect(fallback.finishReason).toBe("stop");
    expect(fallback.latencyMs).toBeGreaterThanOrEqual(400);
    expect(fallback.latencyMs).toBeLessThan(900);
    expect(fallback.latencyMs).toBe(
      model.complete({ provider: "p", model: "m", messages: [] }, ctx).latencyMs,
    );

    expect(() =>
      new ScriptedModelAdapter({}).complete({ provider: "p", model: "m", messages: [] }, ctx),
    ).toThrow(/no handler/);
    expect(estimateTokens("")).toBe(1);
    expect(estimateTokens("abcdefgh")).toBe(2);
  });

  it("MockToolAdapter wraps raw results and rejects unknown tools", () => {
    const tools = new MockToolAdapter({
      raw: (args) => ({ echo: args }),
      wrapped: () => ({ result: 1, latencyMs: 5 }),
    });
    const ctx = { context: {}, state: {}, occurrence: 1, now: 0 };
    expect(tools.execute({ tool: "raw", arguments: { a: 1 } }, ctx)).toEqual({
      result: { echo: { a: 1 } },
    });
    expect(tools.execute({ tool: "wrapped", arguments: null }, ctx)).toEqual({
      result: 1,
      latencyMs: 5,
    });
    expect(() => tools.execute({ tool: "missing", arguments: null }, ctx)).toThrow(
      /unknown tool 'missing'/,
    );
  });

  it("RuleBasedPolicyAdapter allows unknown policies and delegates known ones", () => {
    const policies = new RuleBasedPolicyAdapter({
      strict: () => ({ decision: "deny", reason: "no" }),
    });
    const ctx = { context: {}, state: {}, config: {}, now: 0 };
    expect(policies.evaluate({ policy: "strict", subject: null }, ctx)).toEqual({
      decision: "deny",
      reason: "no",
    });
    expect(policies.evaluate({ policy: "unknown", subject: null }, ctx).decision).toBe("allow");
  });

  it("approval adapters resolve deterministically from the clock", async () => {
    const ctx = { context: {}, state: {}, now: 1234 };
    const pending = await pendingApprovals.request({ reason: "r" }, ctx);
    expect(pending.decision).toBe("pending");
    const again = await pendingApprovals.request({ reason: "other" }, ctx);
    expect(again.approvalId).toBe(pending.approvalId);
    const approved = await approvingAfter(500).request({ reason: "r" }, ctx);
    expect(approved).toMatchObject({ decision: "approved", latencyMs: 500 });
  });

  it("asObject narrows to plain objects", () => {
    expect(asObject({ a: 1 })).toEqual({ a: 1 });
    expect(asObject([1])).toEqual({});
    expect(asObject("x")).toEqual({});
    expect(asObject(undefined)).toEqual({});
  });
});

describe("withAdapters", () => {
  it("routes callback-less calls through the given adapters when the host prefers callbacks", async () => {
    const calls: string[] = [];
    const real: Adapters = {
      model: new ScriptedModelAdapter({ default: () => ({ text: "from adapter", latencyMs: 1 }) }),
      tools: new MockToolAdapter({
        lookup: (args, ctx) => ({ result: { args, occurrence: ctx.occurrence }, latencyMs: 2 }),
      }),
      policies: new RuleBasedPolicyAdapter({
        gate: (subject) => ({
          decision: asObject(subject).ok === true ? "allow" : "deny",
          reason: "rule",
        }),
      }),
    };
    const failing = {
      complete: () => {
        throw new Error("definition adapters must not be used");
      },
      execute: () => {
        throw new Error("definition adapters must not be used");
      },
      evaluate: () => {
        throw new Error("definition adapters must not be used");
      },
    };
    const definition: AgentDefinition<JsonObject> = {
      slug: "wrapped",
      name: "Wrapped",
      createAdapters: () => ({ model: failing, tools: failing, policies: failing }),
      async program(rawHost: AgentHost): Promise<Outcome> {
        const host = withAdapters(rawHost, real);
        expect(host.traceId).toBe(rawHost.traceId);
        expect(host.branchId).toBe(rawHost.branchId);
        expect(host.mode).toBe("record");
        host.context.set("via", "wrapper");
        host.state.set("/n", 1);
        host.note("hello", { ok: true });

        const looked = asObject(await host.tool({ name: "lookup", arguments: { id: 7 } }));
        calls.push("tool");
        expect(looked).toEqual({ args: { id: 7 }, occurrence: 1 });

        const reply = await host.model({
          provider: "p",
          model: "m",
          name: "step",
          messages: [{ role: "user", content: "hi" }],
        });
        calls.push("model");
        expect(reply.message.content).toBe("from adapter");

        const allowed = await host.policy({ policy: "gate", subject: { ok: true } });
        calls.push("policy");
        expect(allowed.decision).toBe("allow");

        await expect(
          host.tool({
            name: "lookup",
            arguments: {},
            guard: { policy: "gate", subject: { ok: false } },
          }),
        ).rejects.toThrow(/blocked by policy 'gate'/);

        const own: JsonValue = await host.tool({
          name: "custom",
          arguments: {},
          execute: () => ({ result: "own callback" }),
        });
        expect(own).toBe("own callback");
        const ownPolicy = await host.policy({
          policy: "custom",
          subject: null,
          evaluate: () => ({ decision: "allow", reason: "own" }),
        });
        expect(ownPolicy.reason).toBe("own");

        const approval = await host.requestApproval({ reason: "why" });
        expect(approval.decision).toBe("pending");
        host.snapshot();
        return { kind: "wrapped", label: "Wrapped run" };
      },
    };
    const result = await recordExecution({
      definition,
      input: {},
      traceId: "trc_wrap",
      branchId: "br_wrap",
      traceName: "wrap",
      seed: "wrap",
      startAt: "2026-01-01T00:00:00.000Z",
    });
    expect(result.status).toBe("completed");
    expect(result.error).toBeNull();
    expect(calls).toEqual(["tool", "model", "policy"]);
    expect(count(result.events, "tool.response", "lookup")).toBe(1);
    expect(count(result.events, "tool.error", "lookup")).toBe(1);
    expect(count(result.events, "policy.denied", "gate")).toBe(1);
    expect(count(result.events, "model.response", "step")).toBe(1);
    expect(count(result.events, "agent.note", "hello")).toBe(1);
    expect(count(result.events, "state.snapshot", "snapshot")).toBe(1);
    expect(count(result.events, "human.approval_requested")).toBe(1);
    expect(count(result.events, "context.added", "via")).toBe(1);
    expect(count(result.events, "state.patch", "/n")).toBe(1);
  });
});
