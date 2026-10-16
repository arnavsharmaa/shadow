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
  parseSpool,
  SpoolTransport,
  type SpoolRecord,
  type SpoolTransportOptions,
} from "./spool.js";
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
export {
  accumulateChatChunks,
  openAITokenUsage,
  runOpenAIToolLoop,
  traceOpenAI,
  type OpenAIToolLoopOptions,
  type OpenAIToolLoopResult,
  type OpenAIChatCompletionLike,
  type OpenAIChatParamsLike,
  type OpenAIResponseLike,
  type OpenAIResponsesParamsLike,
  type TraceOpenAIOptions,
} from "./openai.js";
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
