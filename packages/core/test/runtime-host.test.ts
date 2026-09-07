import type {
  AgentHost,
  JsonObject,
  JsonValue,
  ModelPricing,
  Outcome,
  ShadowEvent,
} from "@shadow/schemas";
import { describe, expect, it } from "vitest";
import {
  EventLog,
  InMemoryStateStore,
  POLICY_BLOCKED_CODE,
  PolicyBlockedError,
  RuntimeHost,
  StaticPricingProvider,
  ToolExecutionError,
  VirtualClock,
  errorToJson,
  normaliseOutcome,
  reconstructState,
  recordExecution,
  seededIdGenerator,
  type AgentDefinition,
  type RecordResult,
} from "../src/index.js";
import {
  BASE_TIME,
  LEDGER_INPUT,
  asObject,
  findEvent,
  ledgerAdapters,
  ledgerAgentDefinition,
  must,
  ofType,
} from "./helpers.js";

type Program = (host: AgentHost, input: JsonObject) => Promise<Outcome | void>;

/** Record an ad-hoc program against the ledger adapters. */
async function record(
  program: Program,
  options: {
    seed?: string;
    input?: JsonObject;
    log?: ReturnType<typeof ledgerAdapters>["log"];
    pricing?: StaticPricingProvider;
    sink?: (e: ShadowEvent) => void;
  } = {},
): Promise<RecordResult> {
  const definition: AgentDefinition<JsonObject> = {
    slug: "adhoc",
    name: "Ad hoc",
    policyConfig: { "ledger.limit": { limit: 100 } },
    createAdapters: () => ledgerAdapters(options.log).adapters,
    program,
    pricing: options.pricing,
  };
  return recordExecution({
    definition,
    input: options.input ?? {},
    traceId: "trc_adhoc",
    branchId: "br_adhoc",
    traceName: "ad hoc",
    seed: options.seed ?? "adhoc",
    startAt: BASE_TIME,
    sink: options.sink,
  });
}

describe("recordExecution lifecycle", () => {
  it("wraps the program in trace and agent lifecycle events", async () => {
    const result = await recordExecution({
      definition: ledgerAgentDefinition,
      input: LEDGER_INPUT,
      traceId: "trc_ledger",
      branchId: "br_ledger",
      traceName: "ledger run",
      seed: "ledger",
      startAt: BASE_TIME,
      traceMetadata: { ticket: "T-9" },
      tags: ["ledger"],
    });
    expect(result.status).toBe("completed");
    expect(result.error).toBeNull();
    expect(result.outcome).toEqual({ kind: "transferred", label: "Transfer executed" });

    const types = result.events.map((e) => e.eventType);
    expect(types[0]).toBe("trace.started");
    expect(types[1]).toBe("agent.started");
    expect(types.slice(-2)).toEqual(["agent.completed", "trace.completed"]);

    const started = must(result.events[0]);
    expect(started.name).toBe("ledger run");
    expect(started.input).toEqual({ name: "ledger run", metadata: { ticket: "T-9" } });
    expect(started.tags).toEqual(["ledger"]);
    expect(started.timestamp).toBe(BASE_TIME);

    const agentStarted = must(result.events[1]);
    expect(agentStarted.input).toEqual({ agent: "ledger-agent", request: LEDGER_INPUT });
    expect(agentStarted.spanId).toMatch(/^spn_/);

    const completed = findEvent(result.events, "agent.completed");
    expect(completed.output).toEqual({ outcome: result.outcome });
    expect(completed.spanId).toBe(agentStarted.spanId);
    expect(completed.durationMs).toBe(100); // 50ms model + 20ms fetch + 30ms transfer

    const traceCompleted = findEvent(result.events, "trace.completed");
    expect(traceCompleted.output).toEqual({ outcome: result.outcome });
    expect(traceCompleted.spanId).toBeNull();

    for (const [index, event] of result.events.entries()) {
      expect(event.sequence).toBe(index);
      expect(event.traceId).toBe("trc_ledger");
      expect(event.branchId).toBe("br_ledger");
      expect(event.source).toBe("sdk");
      expect(event.schemaVersion).toBe("1.0");
      expect(event.metadata.shadow).toMatchObject({ origin: "recorded", scenario: "ledger-agent" });
    }
    expect(result.metrics.eventCount).toBe(result.events.length);
    expect(result.metrics.toolCalls).toBe(2);
    expect(result.metrics.modelCalls).toBe(1);
    expect(result.metrics.policyEvaluations).toBe(1);
    expect(result.metrics.estimatedToolCost).toBe(0.01);
  });

  it("is deterministic for the same seed and start time and differs otherwise", async () => {
    const run = (seed: string, startAt = BASE_TIME) =>
      recordExecution({
        definition: ledgerAgentDefinition,
        input: LEDGER_INPUT,
        traceId: "trc_d",
        branchId: "br_d",
        traceName: "d",
        seed,
        startAt,
      });
    const [a, b, c, d] = await Promise.all([
      run("s1"),
      run("s1"),
      run("s2"),
      run("s1", "2027-01-01T00:00:00.000Z"),
    ]);
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
    expect(a.events.map((e) => e.id)).not.toEqual(c.events.map((e) => e.id));
    expect(a.events.map((e) => e.timestamp)).not.toEqual(d.events.map((e) => e.timestamp));
  });

  it("uses a default outcome when the program returns nothing", async () => {
    const result = await record(async () => undefined);
    expect(result.outcome).toEqual({ kind: "completed", label: "Completed" });
    expect(result.status).toBe("completed");
  });

  it("marks policy violations as failed traces", async () => {
    const result = await record(async () => ({ kind: "policy_violation", label: "Violation" }));
    expect(result.status).toBe("failed");
    expect(result.error).toBeNull();
    const end = must(result.events.at(-1));
    expect(end.eventType).toBe("trace.failed");
    expect(end.severity).toBe("error");
    expect(asObject(end.output).outcome).toEqual({ kind: "policy_violation", label: "Violation" });
  });

  it("records program failures with the error and an error outcome", async () => {
    const result = await record(async () => {
      throw new Error("kaboom");
    });
    expect(result.status).toBe("failed");
    expect(result.error?.message).toBe("kaboom");
    expect(result.outcome).toEqual({ kind: "error", label: "Failed: kaboom" });
    const completed = findEvent(result.events, "agent.completed");
    expect(completed.severity).toBe("error");
    expect(asObject(completed.output).error).toEqual({ message: "kaboom", name: "Error" });
    const failed = findEvent(result.events, "trace.failed");
    expect(asObject(failed.output).error).toEqual({ message: "kaboom", name: "Error" });
  });

  it("wraps non-Error throwables", async () => {
    const result = await record(async () => {
      throw "string failure";
    });
    expect(result.status).toBe("failed");
    expect(result.error?.message).toBe("string failure");
  });

  it("forwards every event to the sink in order and honours custom ids/clock/source", async () => {
    const seen: ShadowEvent[] = [];
    const clock = new VirtualClock("2030-01-01T00:00:00.000Z");
    const result = await recordExecution({
      definition: ledgerAgentDefinition,
      input: LEDGER_INPUT,
      traceId: "trc_sink",
      branchId: "br_sink",
      traceName: "sink",
      ids: seededIdGenerator("custom"),
      clock,
      source: "seed",
      sink: (event) => seen.push(event),
    });
    expect(seen.map((e) => e.id)).toEqual(result.events.map((e) => e.id));
    expect(must(result.events[0]).timestamp).toBe("2030-01-01T00:00:00.000Z");
    expect(must(result.events[0]).source).toBe("seed");
    expect(must(result.events[0]).id).toBe(seededIdGenerator("custom").next("evt"));
    // Latency advances the shared clock.
    expect(clock.now()).toBe(Date.parse("2030-01-01T00:00:00.100Z"));
  });

  it("works with wall-clock time and random ids when no seed is given", async () => {
    const before = Date.now();
    const result = await recordExecution({
      definition: ledgerAgentDefinition,
      input: LEDGER_INPUT,
      traceId: "trc_r",
      branchId: "br_r",
      traceName: "r",
    });
    expect(result.status).toBe("completed");
    expect(Date.parse(must(result.events[0]).timestamp)).toBeGreaterThanOrEqual(before - 1);
    expect(new Set(result.events.map((e) => e.id)).size).toBe(result.events.length);
  });
});

describe("context and state accessors", () => {
  it("emit patch/context events for changes only, with increasing state versions", async () => {
    const result = await record(async (host) => {
      host.context.set("a", 1);
      host.context.set("a", 1); // no-op
      expect(host.context.has("a")).toBe(true);
      expect(host.context.get("a")).toBe(1);
      expect(host.context.all()).toEqual({ a: 1 });
      host.context.remove("a");
      host.context.remove("a"); // no-op
      expect(host.context.has("a")).toBe(false);

      host.state.set("/x/y", [1]);
      host.state.set("/x/y", [1]); // no-op
      expect(host.state.at("/x/y")).toEqual([1]);
      expect(host.state.get()).toEqual({ x: { y: [1] } });
      host.state.remove("/x/y");
      host.state.remove("/nope"); // no-op
      host.state.replace({ z: true });
      host.state.replace({ z: true }); // no-op
      host.state.set("", { root: 1 });
    });
    const mutations = result.events.filter((e) =>
      ["context.added", "context.removed", "state.patch"].includes(e.eventType),
    );
    expect(mutations.map((e) => [e.eventType, e.name])).toEqual([
      ["context.added", "a"],
      ["context.removed", "a"],
      ["state.patch", "/x/y"],
      ["state.patch", "/x/y"],
      ["state.patch", "(root)"],
      ["state.patch", ""],
    ]);
    expect(mutations.map((e) => e.stateVersion)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(must(mutations[0]).output).toEqual({ key: "a", value: 1 });
    expect(must(mutations[1]).output).toEqual({ key: "a" });
    expect(must(mutations[2]).output).toEqual({ ops: [{ op: "add", path: "/x/y", value: [1] }] });
    expect(must(mutations[3]).output).toEqual({ ops: [{ op: "remove", path: "/x/y" }] });
    expect(must(mutations[4]).output).toEqual({
      ops: [{ op: "replace", path: "", value: { z: true } }],
    });
    const reconstructed = reconstructState(result.events);
    expect(reconstructed.state).toEqual({ root: 1 });
    expect(reconstructed.context).toEqual({});
  });

  it("records explicit snapshots and notes", async () => {
    const result = await record(async (host) => {
      host.context.set("k", "v");
      host.state.set("/n", 1);
      host.snapshot();
      host.note("checkpoint", { step: 1 });
      host.note("empty");
    });
    const snapshot = findEvent(result.events, "state.snapshot", "snapshot");
    expect(snapshot.output).toEqual({ state: { n: 1 }, context: { k: "v" } });
    expect(snapshot.stateVersion).toBe(2);
    expect(snapshot.metadata.auto).toBeUndefined();
    const notes = ofType(result.events, "agent.note");
    expect(notes.map((n) => [n.name, n.output, n.severity])).toEqual([
      ["checkpoint", { step: 1 }, "debug"],
      ["empty", null, "debug"],
    ]);
  });
});

describe("tools", () => {
  it("records request/response pairs in their own span with latency and cost", async () => {
    const log = { tools: [], models: [], policies: [] };
    const result = await record(
      async (host) => {
        // `undefined` is not JSON; JS callers can still pass it and it must be dropped.
        const args = { amount: 5, note: undefined } as unknown as JsonValue;
        const out = await host.tool({
          name: "transfer",
          arguments: args,
          tags: ["money"],
          metadata: { attempt: 1 },
        });
        expect(out).toEqual({ ok: true, amount: 5, reference: "tx_1" });
      },
      { log },
    );
    expect(log.tools).toEqual(["transfer"]);
    const request = findEvent(result.events, "tool.request", "transfer");
    const response = findEvent(result.events, "tool.response", "transfer");
    expect(request.input).toEqual({ tool: "transfer", arguments: { amount: 5 } });
    expect(request.tags).toEqual(["money"]);
    expect(request.metadata).toMatchObject({ attempt: 1, shadow: { origin: "recorded" } });
    expect(request.spanId).toMatch(/^spn_/);
    expect(request.parentSpanId).toBe(must(result.events[1]).spanId);
    expect(response.parentEventId).toBe(request.id);
    expect(response.spanId).toBe(request.spanId);
    expect(response.durationMs).toBe(30);
    expect(response.output).toEqual({ result: { ok: true, amount: 5, reference: "tx_1" } });
    expect(response.estimatedCost).toEqual({ amount: 0.01, currency: "USD" });
    expect(Date.parse(response.timestamp) - Date.parse(request.timestamp)).toBe(30);
  });

  it("accepts raw results (without a `result` wrapper) from callbacks", async () => {
    const result = await record(async (host) => {
      const out = await host.tool({
        name: "raw",
        arguments: { a: 1 },
        execute: (args) => ({ echoed: args }),
      });
      expect(out).toEqual({ echoed: { a: 1 } });
      const wrapped = await host.tool({
        name: "wrapped",
        arguments: null,
        execute: () => ({ result: [1, 2] }),
      });
      expect(wrapped).toEqual([1, 2]);
    });
    const response = findEvent(result.events, "tool.response", "raw");
    expect(response.output).toEqual({ result: { echoed: { a: 1 } } });
    expect(response.estimatedCost).toBeNull();
    expect(response.durationMs).toBe(0);
    expect(findEvent(result.events, "tool.response", "wrapped").output).toEqual({ result: [1, 2] });
  });

  it("prefers execute callbacks over adapters when recording", async () => {
    const log = { tools: [], models: [], policies: [] };
    const result = await record(
      async (host) => {
        const out = await host.tool({
          name: "custom",
          arguments: { q: 1 },
          execute: (args, ctx) => ({
            result: { args, occurrence: ctx.occurrence, hasState: typeof ctx.state === "object" },
            latencyMs: 7,
          }),
        });
        expect(out).toEqual({ args: { q: 1 }, occurrence: 1, hasState: true });
        const again = await host.tool({
          name: "custom",
          arguments: {},
          execute: (_args, ctx) => ctx.occurrence,
        });
        expect(again).toBe(2);
      },
      { log },
    );
    expect(log.tools).toEqual([]);
    expect(findEvent(result.events, "tool.response", "custom").durationMs).toBe(7);
  });

  it("records tool.error and rethrows a ToolExecutionError", async () => {
    let caught: unknown;
    const result = await record(async (host) => {
      try {
        await host.tool({ name: "flaky", arguments: {} });
      } catch (error) {
        caught = error;
      }
      return { kind: "recovered", label: "Recovered" };
    });
    expect(caught).toBeInstanceOf(ToolExecutionError);
    expect((caught as ToolExecutionError).code).toBe("ETIMEDOUT");
    expect((caught as ToolExecutionError).retryable).toBe(true);
    expect(result.status).toBe("completed");
    const error = findEvent(result.events, "tool.error", "flaky");
    const request = findEvent(result.events, "tool.request", "flaky");
    expect(error.parentEventId).toBe(request.id);
    expect(error.severity).toBe("error");
    expect(error.output).toEqual({
      error: { message: "upstream timeout", code: "ETIMEDOUT", retryable: true },
    });
    expect(error.durationMs).toBe(0);
    expect(ofType(result.events, "tool.response")).toHaveLength(0);
    expect(result.metrics.toolErrors).toBe(1);
  });

  it("fails the trace when a tool error is not handled by the program", async () => {
    const result = await record(async (host) => {
      await host.tool({ name: "flaky", arguments: {} });
    });
    expect(result.status).toBe("failed");
    expect(result.error).toBeInstanceOf(ToolExecutionError);
    expect(asObject(findEvent(result.events, "trace.failed").output).error).toEqual({
      message: "upstream timeout",
      name: "ToolExecutionError",
      code: "ETIMEDOUT",
    });
  });

  it("wraps plain errors (keeping code/retryable/latency hints) from adapters and callbacks", async () => {
    const result = await record(async (host) => {
      await host.tool({ name: "plain_failure", arguments: {} }).catch((error: unknown) => {
        expect(error).toBeInstanceOf(ToolExecutionError);
        expect((error as ToolExecutionError).code).toBeUndefined();
        expect((error as ToolExecutionError).cause).toBeInstanceOf(Error);
      });
      await host
        .tool({
          name: "slow_failure",
          arguments: {},
          execute: () => {
            throw Object.assign(new Error("gateway timeout"), {
              code: "E_GATEWAY",
              retryable: false,
              latencyMs: 1500,
            });
          },
        })
        .catch((error: unknown) => {
          expect((error as ToolExecutionError).code).toBe("E_GATEWAY");
          expect((error as ToolExecutionError).retryable).toBe(false);
        });
      await host
        .tool({
          name: "weird_failure",
          arguments: {},
          execute: () => {
            throw 42;
          },
        })
        .catch((error: unknown) => {
          expect((error as ToolExecutionError).message).toBe("42");
        });
    });
    expect(findEvent(result.events, "tool.error", "plain_failure").output).toEqual({
      error: { message: "plain failure" },
    });
    const slow = findEvent(result.events, "tool.error", "slow_failure");
    expect(slow.durationMs).toBe(1500);
    expect(slow.output).toEqual({
      error: { message: "gateway timeout", code: "E_GATEWAY", retryable: false },
    });
    expect(findEvent(result.events, "tool.error", "weird_failure").output).toEqual({
      error: { message: "42" },
    });
  });

  it("blocks guarded tools: emits the evaluation, the outcome, a policy_blocked tool.error and throws PolicyBlockedError", async () => {
    const result = await recordExecution({
      definition: ledgerAgentDefinition,
      input: { amount: 150, limit: 200 },
      traceId: "trc_blocked",
      branchId: "br_blocked",
      traceName: "blocked",
      seed: "blocked",
      startAt: BASE_TIME,
    });
    expect(result.outcome?.kind).toBe("escalated");
    const request = findEvent(result.events, "tool.request", "transfer");
    const evaluated = findEvent(result.events, "policy.evaluated", "ledger.limit");
    const denied = findEvent(result.events, "policy.denied", "ledger.limit");
    const error = findEvent(result.events, "tool.error", "transfer");
    expect(evaluated.parentEventId).toBe(request.id);
    expect(evaluated.spanId).toBe(request.spanId);
    expect(evaluated.severity).toBe("warn");
    expect(evaluated.input).toEqual({
      policy: "ledger.limit",
      subject: { amount: 150 },
      config: { limit: 100 },
    });
    expect(evaluated.output).toEqual({
      policy: "ledger.limit",
      decision: "deny",
      reason: "exceeds limit 100",
      details: { limit: 100 },
    });
    expect(denied.parentEventId).toBe(evaluated.id);
    expect(error.parentEventId).toBe(request.id);
    expect(error.severity).toBe("warn");
    expect(asObject(asObject(error.output).error)).toMatchObject({
      code: POLICY_BLOCKED_CODE,
      retryable: false,
    });
    expect(String(asObject(asObject(error.output).error).message)).toMatch(
      /blocked by policy ledger.limit: exceeds limit 100/,
    );
    // The transfer never executed; the program escalated instead.
    expect(ofType(result.events, "tool.response").map((e) => e.name)).toEqual([
      "fetch_balance",
      "escalate",
    ]);
    expect(findEvent(result.events, "tool.request", "escalate").input).toEqual({
      tool: "escalate",
      arguments: { amount: 150, reason: "policy" },
    });
  });

  it("surfaces PolicyBlockedError to the program with the evaluation details", async () => {
    const result = await record(async (host) => {
      await host.tool({
        name: "transfer",
        arguments: { amount: 500 },
        guard: { policy: "ledger.limit", subject: { amount: 500 } },
      });
    });
    expect(result.status).toBe("failed");
    expect(result.error).toBeInstanceOf(PolicyBlockedError);
    const info = (result.error as PolicyBlockedError).info;
    expect(info.tool).toBe("transfer");
    expect(info.evaluation.policy).toBe("ledger.limit");
    expect(info.evaluation.decision).toBe("deny");
    expect(info.evaluation.eventId).toBe(findEvent(result.events, "policy.evaluated").id);
    expect(result.error?.message).toMatch(/blocked by policy 'ledger.limit': deny/);
  });

  it("lets guarded tools run when the guard allows, using call-level config and evaluate callbacks", async () => {
    const log = { tools: [], models: [], policies: [] };
    const result = await record(
      async (host) => {
        await host.tool({
          name: "transfer",
          arguments: { amount: 150 },
          guard: { policy: "ledger.limit", subject: { amount: 150 }, config: { limit: 1000 } },
        });
        await host.tool({
          name: "transfer",
          arguments: { amount: 1 },
          guard: {
            policy: "custom.guard",
            subject: {},
            evaluate: (ctx) => ({
              decision: ctx.config.strict === true ? "deny" : "allow",
              reason: "callback",
            }),
            config: { strict: false },
          },
        });
      },
      { log },
    );
    expect(result.status).toBe("completed");
    expect(log.policies).toEqual(["ledger.limit"]);
    const evaluations = ofType(result.events, "policy.evaluated");
    expect(evaluations.map((e) => asObject(e.output).decision)).toEqual(["allow", "allow"]);
    expect(asObject(must(evaluations[0]).input).config).toEqual({ limit: 1000 });
    expect(ofType(result.events, "policy.allowed")).toHaveLength(2);
    expect(ofType(result.events, "tool.response")).toHaveLength(2);
  });
});

describe("models", () => {
  it("records request/response with token usage and an estimated cost from the pricing table", async () => {
    const result = await record(async (host) => {
      const reply = await host.model({
        provider: "shadow-sim",
        model: "sim-support-mini",
        messages: [{ role: "user", content: "hi" }],
        parameters: { temperature: 0 },
        tags: ["llm"],
      });
      expect(reply.message).toEqual({ role: "assistant", content: "considered 1 messages" });
      expect(reply.tokenUsage).toEqual({ inputTokens: 100, outputTokens: 40, totalTokens: 140 });
    });
    const request = findEvent(result.events, "model.request", "sim-support-mini");
    const response = findEvent(result.events, "model.response", "sim-support-mini");
    expect(request.input).toEqual({
      provider: "shadow-sim",
      model: "sim-support-mini",
      messages: [{ role: "user", content: "hi" }],
      parameters: { temperature: 0 },
    });
    expect(request.tags).toEqual(["llm"]);
    expect(response.parentEventId).toBe(request.id);
    expect(response.durationMs).toBe(50);
    expect(response.tokenUsage).toEqual({ inputTokens: 100, outputTokens: 40, totalTokens: 140 });
    // 100 * 0.4 / 1e6 + 40 * 1.6 / 1e6
    expect(response.estimatedCost).toEqual({
      amount: 0.000104,
      currency: "USD",
      provider: "shadow-sim",
      model: "sim-support-mini",
      pricingVersion: "sim-2026.1",
    });
    expect(response.output).toEqual({
      message: { role: "assistant", content: "considered 1 messages" },
      finishReason: "stop",
    });
    expect(result.metrics.estimatedModelCost).toBe(0.000104);
    expect(result.metrics.totalTokens).toBe(140);
  });

  it("leaves the cost null for unknown models and honours a custom pricing provider", async () => {
    const unknown = await record(async (host) => {
      await host.model({ provider: "acme", model: "unknown-model", name: "step", messages: [] });
    });
    const response = findEvent(unknown.events, "model.response", "step");
    expect(response.estimatedCost).toBeNull();
    expect(response.tokenUsage).not.toBeNull();

    const table: ModelPricing = {
      provider: "acme",
      model: "unknown-model",
      inputPerMillion: 1000,
      outputPerMillion: 1000,
      currency: "USD",
      version: "v1",
    };
    const priced = await record(
      async (host) => {
        await host.model({ provider: "acme", model: "unknown-model", name: "step", messages: [] });
      },
      { pricing: new StaticPricingProvider([table], "v1") },
    );
    expect(findEvent(priced.events, "model.response", "step").estimatedCost?.amount).toBe(0.14);
  });

  it("prefers execute callbacks when recording and copes with missing token usage", async () => {
    const log = { tools: [], models: [], policies: [] };
    const result = await record(
      async (host) => {
        const reply = await host.model({
          provider: "acme",
          model: "cb",
          messages: [],
          execute: () => ({
            message: { role: "assistant", content: "from callback" },
            toolCalls: [{ tool: "x", arguments: {} }],
            latencyMs: 5,
          }),
        });
        expect(reply.message.content).toBe("from callback");
        expect(reply.toolCalls).toEqual([{ tool: "x", arguments: {} }]);
        expect(reply.tokenUsage).toBeUndefined();
      },
      { log },
    );
    expect(log.models).toEqual([]);
    const response = findEvent(result.events, "model.response", "cb");
    expect(response.tokenUsage).toBeNull();
    expect(response.estimatedCost).toBeNull();
    expect(response.durationMs).toBe(5);
    expect(asObject(response.output).toolCalls).toEqual([{ tool: "x", arguments: {} }]);
  });
});

describe("policies and approvals", () => {
  it("records standalone policy evaluations with their outcome event", async () => {
    const result = await record(async (host) => {
      const allowed = await host.policy({ policy: "ledger.limit", subject: { amount: 10 } });
      expect(allowed.decision).toBe("allow");
      expect(allowed.eventId).toMatch(/^evt_/);
      const denied = await host.policy({ policy: "ledger.limit", subject: { amount: 1000 } });
      expect(denied.decision).toBe("deny");
      expect(denied.reason).toBe("exceeds limit 100");
    });
    const evaluations = ofType(result.events, "policy.evaluated");
    expect(evaluations.every((e) => e.parentEventId === null)).toBe(true);
    expect(evaluations.map((e) => e.severity)).toEqual(["info", "warn"]);
    const outcomes = result.events.filter(
      (e) => e.eventType === "policy.allowed" || e.eventType === "policy.denied",
    );
    expect(outcomes.map((e) => e.eventType)).toEqual(["policy.allowed", "policy.denied"]);
    expect(outcomes.map((e) => e.parentEventId)).toEqual(evaluations.map((e) => e.id));
    expect(must(outcomes[1]).output).toEqual({
      policy: "ledger.limit",
      decision: "deny",
      reason: "exceeds limit 100",
    });
    expect(result.metrics.policyEvaluations).toBe(2);
  });

  it("leaves approvals pending without an approval adapter", async () => {
    const result = await record(async (host) => {
      const approval = await host.requestApproval({
        reason: "needs a human",
        request: { amount: 1 },
      });
      expect(approval.decision).toBe("pending");
      expect(approval.approvalId).toMatch(/^apr_/);
    });
    const requested = findEvent(result.events, "human.approval_requested", "approval");
    expect(requested.severity).toBe("warn");
    expect(requested.input).toEqual({ reason: "needs a human", request: { amount: 1 } });
    expect(asObject(requested.output)).toMatchObject({
      reason: "needs a human",
      status: "pending",
      request: { amount: 1 },
    });
    expect(ofType(result.events, "human.approval_resolved")).toHaveLength(0);
  });

  it("records resolved approvals from an approval adapter", async () => {
    const definition: AgentDefinition<JsonObject> = {
      slug: "approver",
      name: "Approver",
      createAdapters: () => ({
        ...ledgerAdapters().adapters,
        approvals: {
          request: () => ({ approvalId: "apr_fixed", decision: "approved", latencyMs: 60_000 }),
        },
      }),
      async program(host) {
        const approval = await host.requestApproval({ reason: "privileged" });
        expect(approval).toEqual({ approvalId: "apr_fixed", decision: "approved" });
      },
    };
    const result = await recordExecution({
      definition,
      input: {},
      traceId: "trc_a",
      branchId: "br_a",
      traceName: "a",
      seed: "a",
      startAt: BASE_TIME,
    });
    const requested = findEvent(result.events, "human.approval_requested");
    const resolved = findEvent(result.events, "human.approval_resolved");
    expect(resolved.parentEventId).toBe(requested.id);
    expect(resolved.output).toEqual({ approvalId: "apr_fixed", decision: "approved" });
    expect(resolved.durationMs).toBe(60_000);
    expect(asObject(requested.output).request).toBeUndefined();
  });
});

describe("RuntimeHost internals", () => {
  it("exposes span, live state and the shared event log", async () => {
    const log = new EventLog({
      traceId: "trc_h",
      branchId: "br_h",
      ids: seededIdGenerator("h"),
      clock: new VirtualClock(0),
      source: "sdk",
    });
    const host = new RuntimeHost({
      traceId: "trc_h",
      branchId: "br_h",
      mode: "record",
      log,
      store: new InMemoryStateStore(),
      clock: new VirtualClock(0),
      adapters: ledgerAdapters().adapters,
      execution: "adapters",
    });
    expect(host.isLive).toBe(true);
    expect(host.currentSpanId).toBeNull();
    expect(host.mode).toBe("record");
    host.setCorrelationId("corr-1");
    await host.withSpan("spn_outer", async () => {
      expect(host.currentSpanId).toBe("spn_outer");
      host.note("inside");
    });
    expect(host.currentSpanId).toBeNull();
    expect(host.events).toHaveLength(1);
    expect(must(host.events[0])).toMatchObject({
      spanId: "spn_outer",
      correlationId: "corr-1",
      eventType: "agent.note",
    });
    host.goLive(); // no-op when already live
    expect(host.isLive).toBe(true);
  });

  it("merges base and per-event metadata, including the shadow namespace", () => {
    const log = new EventLog({
      traceId: "trc_m",
      branchId: "br_m",
      ids: seededIdGenerator("m"),
      clock: new VirtualClock(0),
      source: "sdk",
      baseMetadata: { shadow: { origin: "recorded", scenario: "x" }, base: true },
      startSequence: 10,
    });
    const event = log.emit({
      eventType: "agent.note",
      name: "n",
      metadata: { shadow: { overrideKind: "policy" }, extra: 1 },
    });
    expect(event.sequence).toBe(10);
    expect(log.nextSequence).toBe(11);
    expect(event.metadata).toEqual({
      shadow: { origin: "recorded", scenario: "x", overrideKind: "policy" },
      base: true,
      extra: 1,
    });
    const plain = log.emit({ eventType: "agent.note", name: "n2", at: 5000 });
    expect(plain.metadata).toEqual({ shadow: { origin: "recorded", scenario: "x" }, base: true });
    expect(plain.timestamp).toBe("1970-01-01T00:00:05.000Z");
    expect(log.traceId).toBe("trc_m");
    expect(log.branchId).toBe("br_m");
    expect(log.newSpanId()).toMatch(/^spn_/);
  });
});

describe("helpers", () => {
  it("normaliseOutcome falls back and strips non-JSON values", () => {
    expect(normaliseOutcome(undefined, { kind: "completed", label: "Completed" })).toEqual({
      kind: "completed",
      label: "Completed",
    });
    expect(
      normaliseOutcome({ kind: "x", label: "y", extra: undefined } as Outcome, {
        kind: "c",
        label: "C",
      }),
    ).toEqual({ kind: "x", label: "y" });
  });

  it("errorToJson keeps message, name and string codes", () => {
    expect(errorToJson(new ToolExecutionError("m", { code: "C" }))).toEqual({
      message: "m",
      name: "ToolExecutionError",
      code: "C",
    });
    expect(errorToJson(Object.assign(new Error("m"), { code: 7 }))).toEqual({
      message: "m",
      name: "Error",
    });
    expect(errorToJson("plain")).toEqual({ message: "plain" });
  });
});
