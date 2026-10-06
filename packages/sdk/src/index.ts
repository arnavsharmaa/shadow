export { Shadow, type ShadowOptions, type StartTraceOptions } from "./shadow.js";
export { Trace, ToolError, PolicyBlocked, type TraceOptions } from "./trace.js";
export {
  HttpTransport,
  MemoryTransport,
  NoopTransport,
  TransportError,
  type Transport,
  type TraceHandle,
  type HttpTransportOptions,
} from "./transport.js";
export { createRedactor, DEFAULT_KEY_PATTERNS, type RedactOptions } from "./redact.js";
export {
  anthropicTokenUsage,
  runAnthropicToolLoop,
  traceAnthropic,
  type AnthropicCreateParamsLike,
  type AnthropicMessageLike,
  type AnthropicToolLoopOptions,
  type AnthropicToolLoopResult,
  type TraceAnthropicOptions,
} from "./anthropic.js";
export { traceMcpClient, type McpToolResultLike, type TraceMcpOptions } from "./mcp.js";
export type {
  AgentHost,
  AgentProgram,
  ApprovalRequest,
  ApprovalResolution,
  ContextAccessor,
  IngestEventInput,
  JsonObject,
  JsonValue,
  ModelCall,
  ModelResult,
  Outcome,
  PolicyCall,
  PolicyEvaluation,
  PolicyResult,
  StateAccessor,
  ToolCall,
  ToolResult,
  TokenUsage,
} from "@shadow/schemas";
