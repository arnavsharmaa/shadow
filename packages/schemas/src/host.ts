/**
 * Contract between an agent program and the runtime that records it.
 *
 * The same program can run under:
 *   - `@shadow/sdk`'s `Trace` (live recording against real tools/models),
 *   - `@shadow/core`'s recording runtime with deterministic adapters (seeds, tests),
 *   - `@shadow/core`'s replay runtime (deterministic counterfactuals).
 *
 * These are plain TypeScript interfaces; they carry no runtime code.
 */
import type {
  ModelRequestPayload,
  ModelResponsePayload,
  Outcome,
  PolicyDecision,
  TokenUsage,
} from "./events.js";
import type { JsonObject, JsonValue } from "./json.js";

export interface ContextAccessor {
  get(key: string): JsonValue | undefined;
  has(key: string): boolean;
  set(key: string, value: JsonValue): void;
  remove(key: string): void;
  all(): JsonObject;
}

export interface StateAccessor {
  /** Current state (a deep-frozen or cloned object; do not mutate). */
  get(): JsonObject;
  /** Read a JSON-pointer path (`/orders/0/id`). */
  at(path: string): JsonValue | undefined;
  /** Set a JSON-pointer path. Creates intermediate objects. */
  set(path: string, value: JsonValue): void;
  /** Remove a JSON-pointer path. */
  remove(path: string): void;
  /** Replace the whole state object. */
  replace(next: JsonObject): void;
}

export interface ToolExecutionContext {
  context: JsonObject;
  state: JsonObject;
  /** 1-based count of calls to this tool so far in this execution. */
  occurrence: number;
}

export interface ToolResult {
  result: JsonValue;
  /** Simulated or measured latency; recorded as the response duration. */
  latencyMs?: number;
  /** Optional per-call cost estimate for paid tools. */
  estimatedCost?: number;
}

export interface PolicyResult {
  decision: PolicyDecision;
  reason?: string;
  details?: JsonObject;
}

export interface PolicyEvaluationContext {
  context: JsonObject;
  state: JsonObject;
  /** Policy configuration, possibly modified by a policy override. */
  config: JsonObject;
}

export interface ToolCall {
  name: string;
  arguments: JsonValue;
  /** Live implementation. Ignored by deterministic replay. */
  execute?: (
    args: JsonValue,
    ctx: ToolExecutionContext,
  ) => Promise<ToolResult | JsonValue> | ToolResult | JsonValue;
  /** Evaluate a policy inside the tool span before executing. */
  guard?: PolicyCall;
  tags?: string[];
  metadata?: JsonObject;
}

export interface ModelResult extends ModelResponsePayload {
  tokenUsage?: TokenUsage;
  latencyMs?: number;
  /** Optional cost estimate (USD) when the caller already knows pricing. */
  estimatedCost?: number;
}

export interface ModelCall extends ModelRequestPayload {
  /** Human readable step name (defaults to the model name). */
  name?: string;
  /** Live implementation. Ignored by deterministic replay. */
  execute?: (request: ModelRequestPayload) => Promise<ModelResult> | ModelResult;
  tags?: string[];
  metadata?: JsonObject;
}

export interface PolicyCall {
  policy: string;
  subject: JsonValue;
  /** Live implementation. Ignored by deterministic replay. */
  evaluate?: (ctx: PolicyEvaluationContext) => Promise<PolicyResult> | PolicyResult;
  config?: JsonObject;
}

export interface PolicyEvaluation extends PolicyResult {
  policy: string;
  eventId: string;
}

export interface ApprovalRequest {
  reason: string;
  request?: JsonValue;
}

export interface ApprovalResolution {
  approvalId: string;
  decision: "approved" | "rejected" | "pending";
}

/** Thrown by `tool()` when its guard policy does not allow execution. */
export interface PolicyBlockedInfo {
  tool: string;
  evaluation: PolicyEvaluation;
}

export interface AgentHost {
  readonly traceId: string;
  readonly branchId: string;
  readonly mode: "record" | "replay";
  readonly context: ContextAccessor;
  readonly state: StateAccessor;
  tool(call: ToolCall): Promise<JsonValue>;
  model(call: ModelCall): Promise<ModelResult>;
  policy(call: PolicyCall): Promise<PolicyEvaluation>;
  requestApproval(request: ApprovalRequest): Promise<ApprovalResolution>;
  /** Record a full state snapshot now. */
  snapshot(): void;
  /** Attach a free-form note event. */
  note(name: string, data?: JsonValue): void;
}

export type AgentProgram<Input extends JsonValue = JsonValue> = (
  host: AgentHost,
  input: Input,
) => Promise<Outcome | void>;
