/**
 * Shared factories for the core test-suite.
 *
 * The deterministic demo scenarios live in `@shadow/testkit`, which itself
 * depends on `@shadow/core`. Declaring testkit as a devDependency of core
 * would create a workspace cycle (which turbo rejects), so the scenario
 * sources are reached through a single relative import here. Vite and
 * TypeScript both resolve the symlinked `@shadow/core` inside testkit back to
 * this package's `src/`, so class identities (`PolicyBlockedError`, ...) are
 * shared.
 */
import type {
  Branch,
  Fork,
  JsonObject,
  JsonValue,
  ModelRequestPayload,
  ModelResult,
  Outcome,
  Override,
  PolicyResult,
  ShadowEvent,
  ToolResult,
  Trace,
  TraceExportInput,
} from "@shadow/schemas";
import { emptyBranchMetrics } from "@shadow/schemas";
import {
  createFork,
  createReplay,
  effectiveEvents,
  executeReplay,
  recordExecution,
  seededIdGenerator,
  VirtualClock,
  PolicyBlockedError,
  ToolExecutionError,
  type Adapters,
  type AgentDefinition,
  type ModelAdapter,
  type PolicyAdapter,
  type RecordResult,
  type ReplayOutcome,
  type ToolAdapter,
} from "../src/index.js";
import type { DemoTraceSpec } from "../../testkit/src/index.js";

export {
  demoTraces,
  DEMO_TRACE_IDS,
  refundAgentDefinition,
  inventoryAgentDefinition,
  faqAgentDefinition,
  enrichmentAgentDefinition,
  accessAgentDefinition,
  syntheticAgentDefinition,
} from "../../testkit/src/index.js";
export type { DemoTraceSpec } from "../../testkit/src/index.js";

export const BASE_TIME = "2026-09-01T09:00:00.000Z";
export const BASE_TIME_MS = Date.parse(BASE_TIME);

/** Throws when a value is missing; avoids non-null assertions in tests. */
export function must<T>(value: T | undefined | null, what = "value"): T {
  if (value === undefined || value === null) throw new Error(`expected ${what} to be present`);
  return value;
}

export function asObject(value: JsonValue | undefined): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

// ---------------------------------------------------------------------------
// Entity factories
// ---------------------------------------------------------------------------

export type EventOverrides = Partial<ShadowEvent> & { sequence: number };

export function makeEvent(overrides: EventOverrides): ShadowEvent {
  const sequence = overrides.sequence;
  return {
    id: `evt_${sequence}`,
    schemaVersion: "1.0",
    traceId: "trc_test",
    branchId: "br_root",
    parentEventId: null,
    spanId: null,
    parentSpanId: null,
    timestamp: new Date(BASE_TIME_MS + sequence * 1000).toISOString(),
    durationMs: null,
    eventType: "agent.note",
    source: "sdk",
    severity: "info",
    name: `note-${sequence}`,
    metadata: {},
    tags: [],
    tokenUsage: null,
    estimatedCost: null,
    stateVersion: null,
    correlationId: null,
    ...overrides,
  };
}

/** Build a list of simple events with consecutive sequences. */
export function makeEvents(
  count: number,
  extra: (sequence: number) => Partial<ShadowEvent> = () => ({}),
): ShadowEvent[] {
  return Array.from({ length: count }, (_, i) => makeEvent({ sequence: i, ...extra(i) }));
}

export function makeBranch(overrides: Partial<Branch> & { id: string }): Branch {
  return {
    traceId: "trc_test",
    name: overrides.id,
    parentBranchId: null,
    forkId: null,
    forkEventId: null,
    forkSequence: null,
    depth: 0,
    status: "completed",
    outcome: null,
    metrics: emptyBranchMetrics(),
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
    metadata: {},
    ...overrides,
  };
}

export function makeTrace(overrides: Partial<Trace> = {}): Trace {
  return {
    id: "trc_test",
    projectId: "prj_test",
    agentId: "agt_test",
    rootBranchId: "br_root",
    name: "test trace",
    status: "completed",
    schemaVersion: "1.0",
    startedAt: BASE_TIME,
    completedAt: null,
    durationMs: null,
    outcome: null,
    tags: [],
    metadata: {},
    metrics: emptyBranchMetrics(),
    branchCount: 1,
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
    ...overrides,
  };
}

export function makeFork(overrides: Partial<Fork> & { id: string; childBranchId: string }): Fork {
  return {
    traceId: "trc_test",
    parentBranchId: "br_root",
    forkEventId: "evt_1",
    forkSequence: 0,
    overrides: [],
    createdAt: BASE_TIME,
    metadata: {},
    ...overrides,
  };
}

export interface BundleParts {
  trace?: Partial<Trace>;
  branches?: Branch[];
  events?: ShadowEvent[];
  forks?: Fork[];
  format?: string;
  schemaVersion?: string;
}

/** A structurally valid export bundle (input form, before zod defaults). */
export function makeBundle(
  parts: BundleParts = {},
): Omit<TraceExportInput, "format"> & { format: string } {
  const trace = makeTrace(parts.trace);
  const branches = parts.branches ?? [makeBranch({ id: trace.rootBranchId, traceId: trace.id })];
  const events =
    parts.events ??
    makeEvents(3, () => ({ traceId: trace.id, branchId: trace.rootBranchId })).map((e) => ({
      ...e,
      traceId: trace.id,
    }));
  return {
    format: parts.format ?? "shadow.trace",
    schemaVersion: parts.schemaVersion ?? "1.0",
    exportedAt: BASE_TIME,
    project: { slug: "support-agent", name: "Support Agent", description: null, metadata: {} },
    agent: { slug: "refund-agent", name: "Refund Agent", description: null, metadata: {} },
    trace,
    branches,
    forks: parts.forks ?? [],
    replays: [],
    events,
    comparisons: [],
  };
}

// ---------------------------------------------------------------------------
// Recording, forking and replaying scenarios
// ---------------------------------------------------------------------------

export function findEvent(
  events: readonly ShadowEvent[],
  eventType: string,
  name?: string,
  occurrence = 1,
): ShadowEvent {
  let seen = 0;
  for (const event of events) {
    if (event.eventType !== eventType) continue;
    if (name !== undefined && event.name !== name) continue;
    seen += 1;
    if (seen === occurrence) return event;
  }
  throw new Error(`event ${eventType}${name ? ` '${name}'` : ""} #${occurrence} not found`);
}

export function ofType(events: readonly ShadowEvent[], eventType: string): ShadowEvent[] {
  return events.filter((e) => e.eventType === eventType);
}

export interface Recorded {
  spec: DemoTraceSpec;
  result: RecordResult;
  trace: Trace;
  root: Branch;
}

export async function recordScenario(spec: DemoTraceSpec): Promise<Recorded> {
  const result = await recordExecution({
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
  const root = makeBranch({
    id: spec.rootBranchId,
    traceId: spec.traceId,
    name: "main",
    status: result.status,
    outcome: result.outcome,
    metrics: result.metrics,
    createdAt: spec.startAt,
    updatedAt: spec.startAt,
  });
  const trace = makeTrace({
    id: spec.traceId,
    rootBranchId: root.id,
    name: spec.name,
    status: result.status,
    startedAt: spec.startAt,
    outcome: result.outcome,
    metrics: result.metrics,
  });
  return { spec, result, trace, root };
}

/** Record an arbitrary definition as a root branch with deterministic settings. */
export async function recordDefinition<Input extends JsonValue>(
  definition: AgentDefinition<Input>,
  input: Input,
  options: { seed?: string; traceId?: string; branchId?: string; startAt?: string } = {},
): Promise<Recorded> {
  const traceId = options.traceId ?? "trc_custom";
  const branchId = options.branchId ?? "br_custom_main";
  const startAt = options.startAt ?? BASE_TIME;
  const spec: DemoTraceSpec = {
    traceId,
    rootBranchId: branchId,
    agent: definition as unknown as AgentDefinition,
    name: `${definition.slug} run`,
    input,
    seed: options.seed ?? `${definition.slug}-seed`,
    startAt,
    tags: [],
    metadata: {},
  };
  return recordScenario(spec);
}

export interface ForkedReplay {
  branch: Branch;
  fork: Fork;
  /** Events stored on the child branch (fork.created + replay output). */
  ownEvents: ShadowEvent[];
  /** Effective lineage of the child branch. */
  lineage: ShadowEvent[];
  replay: ReplayOutcome;
}

export interface ForkAndReplayOptions {
  trace: Trace;
  definition: AgentDefinition;
  parentBranch: Branch;
  parentLineage: readonly ShadowEvent[];
  existingBranches: readonly Branch[];
  forkEventId: string;
  overrides: Override[];
  inheritedOverrides?: Override[];
  name?: string;
  seed?: string;
}

/** Fork a branch at an event, replay it and return the child's effective lineage. */
export async function forkAndReplay(options: ForkAndReplayOptions): Promise<ForkedReplay> {
  const seed = options.seed ?? `fork:${options.forkEventId}`;
  const forked = createFork({
    trace: options.trace,
    parentBranch: options.parentBranch,
    lineage: options.parentLineage,
    existingBranches: options.existingBranches,
    forkEventId: options.forkEventId,
    overrides: options.overrides,
    name: options.name,
    ids: seededIdGenerator(seed),
    clock: new VirtualClock(options.trace.startedAt),
  });
  const plan = createReplay({
    trace: options.trace,
    branch: forked.branch,
    fork: forked.fork,
    parentLineage: options.parentLineage,
    existingBranchEvents: forked.events,
    inheritedOverrides: options.inheritedOverrides,
  });
  const replay = await executeReplay(plan, options.definition);
  const branch: Branch = {
    ...forked.branch,
    status: replay.branchStatus,
    outcome: replay.outcome,
    metrics: replay.metrics,
  };
  const ownEvents = [...forked.events, ...replay.events];
  const parentChain = [...options.existingBranches];
  if (!parentChain.some((b) => b.id === options.parentBranch.id))
    parentChain.push(options.parentBranch);
  const lineage = effectiveEvents([...parentChain, branch], branch.id, (id) =>
    id === branch.id ? ownEvents : id === options.parentBranch.id ? options.parentLineage : [],
  );
  return { branch, fork: forked.fork, ownEvents, lineage, replay };
}

// ---------------------------------------------------------------------------
// A small, fully controllable agent for runtime tests
// ---------------------------------------------------------------------------

export interface LedgerInput extends JsonObject {
  amount: number;
  limit: number;
}

export interface LedgerAdapterLog {
  tools: string[];
  models: string[];
  policies: string[];
}

export function ledgerAdapters(log: LedgerAdapterLog = { tools: [], models: [], policies: [] }): {
  log: LedgerAdapterLog;
  adapters: Adapters;
} {
  const model: ModelAdapter = {
    complete: (request: ModelRequestPayload): ModelResult => {
      log.models.push(request.model);
      return {
        message: { role: "assistant", content: `considered ${request.messages.length} messages` },
        finishReason: "stop",
        tokenUsage: { inputTokens: 100, outputTokens: 40, totalTokens: 140 },
        latencyMs: 50,
      };
    },
  };
  const tools: ToolAdapter = {
    execute: (call): ToolResult => {
      log.tools.push(call.tool);
      const args = asObject(call.arguments);
      switch (call.tool) {
        case "fetch_balance":
          return { result: { account: args.account ?? null, balance: 250 }, latencyMs: 20 };
        case "transfer":
          return {
            result: { ok: true, amount: args.amount ?? null, reference: "tx_1" },
            latencyMs: 30,
            estimatedCost: 0.01,
          };
        case "escalate":
          return { result: { ticket: "T-1", reason: args.reason ?? "limit" }, latencyMs: 10 };
        case "flaky":
          throw new ToolExecutionError("upstream timeout", { code: "ETIMEDOUT", retryable: true });
        case "plain_failure":
          throw new Error("plain failure");
        default:
          throw new ToolExecutionError(`unknown tool '${call.tool}'`, { code: "unknown_tool" });
      }
    },
  };
  const policies: PolicyAdapter = {
    evaluate: (call, ctx): PolicyResult => {
      log.policies.push(call.policy);
      const limit = typeof ctx.config.limit === "number" ? ctx.config.limit : 0;
      const amount = Number(asObject(call.subject).amount ?? 0);
      return amount <= limit
        ? { decision: "allow", reason: `within limit ${limit}`, details: { limit } }
        : { decision: "deny", reason: `exceeds limit ${limit}`, details: { limit } };
    },
  };
  return { log, adapters: { model, tools, policies } };
}

/**
 * Transfers `amount` when the balance covers it and it is under the state
 * limit; the transfer itself is guarded by the `ledger.limit` policy.
 */
export const ledgerAgentDefinition: AgentDefinition<LedgerInput> = {
  slug: "ledger-agent",
  name: "Ledger Agent",
  policyConfig: { "ledger.limit": { limit: 100 } },
  createAdapters: () => ledgerAdapters().adapters,
  async program(host, input): Promise<Outcome> {
    host.context.set("currency", "USD");
    host.state.set("/limit", input.limit);
    host.state.set("/amount", input.amount);
    await host.model({
      provider: "shadow-sim",
      model: "sim-support-mini",
      name: "think",
      messages: [{ role: "user", content: `transfer ${input.amount}` }],
    });
    const balance = asObject(
      await host.tool({ name: "fetch_balance", arguments: { account: "acc_1" } }),
    );
    host.state.set("/balance", balance.balance ?? 0);
    const limit = Number(host.state.at("/limit") ?? 0);
    let transferred = false;
    if (Number(balance.balance ?? 0) >= input.amount && input.amount <= limit) {
      try {
        const transfer = asObject(
          await host.tool({
            name: "transfer",
            arguments: { amount: input.amount },
            guard: { policy: "ledger.limit", subject: { amount: input.amount } },
          }),
        );
        host.state.set("/transfer", transfer);
        transferred = true;
      } catch (error) {
        if (!(error instanceof PolicyBlockedError)) throw error;
        const ticket = asObject(
          await host.tool({
            name: "escalate",
            arguments: { amount: input.amount, reason: "policy" },
          }),
        );
        host.state.set("/escalation", ticket);
      }
    } else {
      const ticket = asObject(
        await host.tool({
          name: "escalate",
          arguments: { amount: input.amount, reason: "insufficient" },
        }),
      );
      host.state.set("/escalation", ticket);
    }
    host.note("done", { transferred });
    host.snapshot();
    return transferred
      ? { kind: "transferred", label: "Transfer executed" }
      : { kind: "escalated", label: "Escalated to a human" };
  },
};

/** Same adapters, but the program performs a different first operation. */
export const ledgerVariantDefinition: AgentDefinition<LedgerInput> = {
  ...ledgerAgentDefinition,
  slug: "ledger-agent-variant",
  async program(host, input): Promise<Outcome> {
    host.context.set("currency", "USD");
    host.state.set("/limit", input.limit);
    host.state.set("/amount", input.amount);
    await host.tool({ name: "fetch_balance", arguments: { account: "acc_1" } });
    await host.model({
      provider: "shadow-sim",
      model: "sim-support-mini",
      name: "think",
      messages: [{ role: "user", content: `transfer ${input.amount}` }],
    });
    return { kind: "completed", label: "Completed" };
  },
};

/** Same operations as the ledger agent but with different tool arguments. */
export const ledgerArgumentsVariantDefinition: AgentDefinition<LedgerInput> = {
  ...ledgerAgentDefinition,
  slug: "ledger-agent-arguments-variant",
  async program(host, input): Promise<Outcome> {
    host.context.set("currency", "USD");
    host.state.set("/limit", input.limit);
    host.state.set("/amount", input.amount);
    await host.model({
      provider: "shadow-sim",
      model: "sim-support-mini",
      name: "think",
      messages: [{ role: "user", content: `transfer ${input.amount}` }],
    });
    await host.tool({ name: "fetch_balance", arguments: { account: "acc_2" } });
    return { kind: "completed", label: "Completed" };
  },
};

export const LEDGER_INPUT: LedgerInput = { amount: 80, limit: 200 };
