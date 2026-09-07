import type {
  Adapters,
  AdapterContext,
  AgentDefinition,
  ModelAdapter,
  PolicyAdapter,
  ToolAdapter,
  ApprovalAdapter,
} from "@shadow/core";
import { ToolExecutionError, defaultPricingProvider, estimateModelCost, fnv1a } from "@shadow/core";
import type {
  AgentHost,
  ApprovalRequest,
  JsonObject,
  JsonValue,
  ModelRequestPayload,
  ModelResult,
  PolicyEvaluationContext,
  PolicyResult,
  ToolExecutionContext,
  ToolResult,
  ToolCall,
  ModelCall,
  PolicyCall,
} from "@shadow/schemas";

/** Deterministic token accounting: roughly four characters per token. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function usageFor(request: ModelRequestPayload, outputText: string) {
  const inputText = request.messages.map((m) => JSON.stringify(m.content)).join("\n");
  const inputTokens = estimateTokens(inputText) + 12 * request.messages.length;
  const outputTokens = estimateTokens(outputText);
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

export type ScriptedStep = (
  request: ModelRequestPayload,
  ctx: AdapterContext,
) => {
  text: string;
  toolCalls?: { tool: string; arguments: JsonValue }[];
  latencyMs?: number;
  data?: JsonValue;
};

/**
 * A "model" that answers deterministically based on `parameters.step`. No
 * network, no keys: the bundled scenarios use it to stand in for an LLM.
 */
export class ScriptedModelAdapter implements ModelAdapter {
  constructor(private readonly steps: Record<string, ScriptedStep>) {}

  complete(request: ModelRequestPayload, ctx: AdapterContext): ModelResult {
    const step = String(request.parameters?.step ?? "default");
    const handler = this.steps[step] ?? this.steps.default;
    if (!handler) throw new Error(`scripted model has no handler for step '${step}'`);
    const reply = handler(request, ctx);
    const content: JsonValue =
      reply.data === undefined ? reply.text : { text: reply.text, data: reply.data };
    return {
      message: { role: "assistant", content },
      finishReason: reply.toolCalls ? "tool_calls" : "stop",
      ...(reply.toolCalls ? { toolCalls: reply.toolCalls } : {}),
      tokenUsage: usageFor(
        request,
        reply.text + (reply.data === undefined ? "" : JSON.stringify(reply.data)),
      ),
      latencyMs: reply.latencyMs ?? 400 + (fnv1a(`${step}:${request.model}`) % 500),
    };
  }
}

export type MockTool = (
  args: JsonValue,
  ctx: ToolExecutionContext & AdapterContext,
) => ToolResult | JsonValue;

export class MockToolAdapter implements ToolAdapter {
  constructor(private readonly tools: Record<string, MockTool>) {}

  execute(
    call: { tool: string; arguments: JsonValue },
    ctx: ToolExecutionContext & AdapterContext,
  ) {
    const tool = this.tools[call.tool];
    if (!tool)
      throw new ToolExecutionError(`unknown tool '${call.tool}'`, { code: "unknown_tool" });
    const raw = tool(call.arguments, ctx);
    if (raw !== null && typeof raw === "object" && !Array.isArray(raw) && "result" in raw)
      return raw as ToolResult;
    return { result: raw as JsonValue };
  }
}

export type MockPolicy = (
  subject: JsonValue,
  ctx: PolicyEvaluationContext & AdapterContext,
) => PolicyResult;

export class RuleBasedPolicyAdapter implements PolicyAdapter {
  constructor(private readonly policies: Record<string, MockPolicy>) {}

  evaluate(
    call: { policy: string; subject: JsonValue },
    ctx: PolicyEvaluationContext & AdapterContext,
  ): PolicyResult {
    const policy = this.policies[call.policy];
    if (!policy) return { decision: "allow", reason: `no rule registered for ${call.policy}` };
    return policy(call.subject, ctx);
  }
}

/** Approval adapter that never resolves (requests stay pending). */
export const pendingApprovals: ApprovalAdapter = {
  request: (_request: ApprovalRequest, ctx) => ({
    approvalId: `apr_${fnv1a(String(ctx.now)).toString(16)}`,
    decision: "pending",
  }),
};

/** Approval adapter that approves after a fixed simulated wait. */
export function approvingAfter(latencyMs: number): ApprovalAdapter {
  return {
    request: (_request, ctx) => ({
      approvalId: `apr_${fnv1a(String(ctx.now)).toString(16)}`,
      decision: "approved",
      latencyMs,
    }),
  };
}

export function asObject(value: JsonValue | undefined): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

export interface WithAdaptersOptions {
  /** Default policy configuration (usually `definition.policyConfig`). */
  policyConfig?: Record<string, JsonObject>;
  /** Sleep for each adapter's simulated latency (scaled) so live traces look realistic. */
  simulateLatency?: number | boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function simulate<T extends { latencyMs?: number }>(value: T, factor: number): Promise<T> {
  if (factor > 0 && value.latencyMs) await sleep(value.latencyMs * factor);
  return value;
}

/**
 * Wrap a host so that calls without `execute`/`evaluate` callbacks run
 * against the given adapters. Lets a program written for deterministic
 * adapters run under the SDK (which only knows callbacks).
 */
export function withAdapters(
  host: AgentHost,
  adapters: Adapters,
  options: WithAdaptersOptions = {},
): AgentHost {
  const now = () => Date.now();
  const factor =
    options.simulateLatency === true
      ? 1
      : typeof options.simulateLatency === "number"
        ? options.simulateLatency
        : 0;
  const policyConfig = options.policyConfig ?? {};
  const guard = (call: PolicyCall): PolicyCall => ({
    ...call,
    config: { ...(policyConfig[call.policy] ?? {}), ...(call.config ?? {}) },
    evaluate:
      call.evaluate ??
      ((ctx) =>
        adapters.policies.evaluate(
          { policy: call.policy, subject: call.subject },
          { ...ctx, now: now() },
        )),
  });
  return {
    get traceId() {
      return host.traceId;
    },
    get branchId() {
      return host.branchId;
    },
    get mode() {
      return host.mode;
    },
    context: host.context,
    state: host.state,
    snapshot: () => host.snapshot(),
    note: (name, data) => host.note(name, data),
    requestApproval: (request) => host.requestApproval(request),
    tool: (call: ToolCall) =>
      host.tool({
        ...call,
        execute:
          call.execute ??
          (async (args, ctx) => {
            try {
              return await simulate(
                await adapters.tools.execute(
                  { tool: call.name, arguments: args },
                  { ...ctx, now: now() },
                ),
                factor,
              );
            } catch (error) {
              const latency = (error as { latencyMs?: unknown }).latencyMs;
              if (typeof latency === "number") await simulate({ latencyMs: latency }, factor);
              throw error;
            }
          }),
        guard: call.guard ? guard(call.guard) : undefined,
      }),
    model: (call: ModelCall) =>
      host.model({
        ...call,
        execute:
          call.execute ??
          (async (request) => {
            const result = await simulate(
              await adapters.model.complete(request, {
                context: host.context.all(),
                state: host.state.get(),
                now: now(),
              }),
              factor,
            );
            const cost = result.tokenUsage
              ? estimateModelCost(
                  result.tokenUsage,
                  defaultPricingProvider.lookup(request.provider, request.model),
                )
              : null;
            return cost ? { ...result, estimatedCost: cost.amount } : result;
          }),
      }),
    policy: (call: PolicyCall) => host.policy(guard(call)),
  };
}

/** Bind a replayable definition to any host (for example an SDK `Trace`). */
export function withDefinition<Input extends JsonValue>(
  host: AgentHost,
  definition: AgentDefinition<Input>,
  options: { seed?: string; simulateLatency?: number | boolean } = {},
): { host: AgentHost; run: (input: Input) => ReturnType<AgentDefinition<Input>["program"]> } {
  const bound = withAdapters(
    host,
    definition.createAdapters({ seed: options.seed ?? host.traceId }),
    {
      policyConfig: definition.policyConfig,
      simulateLatency: options.simulateLatency,
    },
  );
  return { host: bound, run: (input) => definition.program(bound, input) };
}
