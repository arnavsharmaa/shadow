import type {
  AgentProgram,
  ApprovalRequest,
  ApprovalResolution,
  JsonObject,
  JsonValue,
  ModelRequestPayload,
  ModelResult,
  PolicyBlockedInfo,
  PolicyEvaluationContext,
  PolicyResult,
  ToolExecutionContext,
  ToolResult,
} from "@shadow/schemas";
import type { PricingProvider } from "../metrics/pricing.js";
import type { SnapshotPolicy } from "../state/reconstruct.js";

export interface AdapterContext {
  context: JsonObject;
  state: JsonObject;
  /** Virtual or real time in ms since epoch. */
  now: number;
}

export interface ModelAdapter {
  complete(request: ModelRequestPayload, ctx: AdapterContext): Promise<ModelResult> | ModelResult;
}

export interface ToolAdapter {
  execute(
    call: { tool: string; arguments: JsonValue },
    ctx: ToolExecutionContext & AdapterContext,
  ): Promise<ToolResult> | ToolResult;
}

export interface PolicyAdapter {
  evaluate(
    call: { policy: string; subject: JsonValue },
    ctx: PolicyEvaluationContext & AdapterContext,
  ): Promise<PolicyResult> | PolicyResult;
}

export interface ApprovalAdapter {
  request(
    request: ApprovalRequest,
    ctx: AdapterContext,
  ):
    | Promise<ApprovalResolution & { latencyMs?: number }>
    | (ApprovalResolution & { latencyMs?: number });
}

export interface Adapters {
  model: ModelAdapter;
  tools: ToolAdapter;
  policies: PolicyAdapter;
  approvals?: ApprovalAdapter;
}

/**
 * A replayable agent: the program plus factories for the deterministic
 * adapters it runs against. Registered with the API so forks can be replayed.
 */
export interface AgentDefinition<Input extends JsonValue = JsonValue> {
  slug: string;
  name: string;
  description?: string;
  program: AgentProgram<Input>;
  createAdapters(options: { seed: string }): Adapters;
  /** Default configuration per policy id (overridable by policy overrides). */
  policyConfig?: Record<string, JsonObject>;
  pricing?: PricingProvider;
  snapshotPolicy?: SnapshotPolicy;
  /** Default model identity used for cost estimation of adapter completions. */
  tags?: string[];
}

export class ToolExecutionError extends Error {
  readonly code: string | undefined;
  readonly retryable: boolean | undefined;
  constructor(
    message: string,
    options: { code?: string; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ToolExecutionError";
    this.code = options.code;
    this.retryable = options.retryable;
  }
}

export class PolicyBlockedError extends Error {
  constructor(readonly info: PolicyBlockedInfo) {
    super(
      `tool '${info.tool}' blocked by policy '${info.evaluation.policy}': ${info.evaluation.decision}`,
    );
    this.name = "PolicyBlockedError";
  }
}

export class ReplayHistoryMismatchError extends Error {
  constructor(
    message: string,
    readonly details: JsonObject = {},
  ) {
    super(message);
    this.name = "ReplayHistoryMismatchError";
  }
}

export const POLICY_BLOCKED_CODE = "policy_blocked";
