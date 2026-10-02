# Anthropic tool-use traces

> **Status: implemented for recording and import.** `traceAnthropic` and
> `runAnthropicToolLoop` in `@shadow/sdk` record live Messages API calls, and `POST
/api/v1/import/anthropic` / `shadow import anthropic <file>` import stored histories.
> Deterministic replay of these traces is still a design proposal (see [Replay](#replay)).

## Recording live calls

Wrap the client once per trace. The wrapper returns the same client type, so the rest of the
code keeps using the Anthropic SDK as before:

```ts
import Anthropic from "@anthropic-ai/sdk";
import { Shadow, traceAnthropic, runAnthropicToolLoop } from "@shadow/sdk";

const shadow = new Shadow({ project: "support", agent: "claude-refund-agent" });
const trace = shadow.startTrace({ name: "ticket-1234" });
const client = traceAnthropic(trace, new Anthropic());

const { message } = await runAnthropicToolLoop(trace, client.beta, {
  params: {
    model: "claude-opus-5-5",
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    // Server-side fallback: a policy decline is re-run on a fallback model in the same call.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: "You are a customer-support agent.",
    tools: [lookupOrderTool, refundOrderTool],
    messages: [{ role: "user", content: "My headphones (order ord_5001) arrived broken." }],
  },
  tools: {
    lookup_order: (input) => orders.get((input as { orderId: string }).orderId),
    refund_order: (input) => payments.refund(input),
  },
  guard: (tool, input) =>
    tool === "refund_order"
      ? { policy: "refund.autonomous_limit", subject: input, evaluate: checkRefundLimit }
      : undefined,
});
if (message.stop_reason === "refusal") {
  // every model in the fallback chain declined
}
await trace.end();
```

- **`traceAnthropic(trace, client, options?)`** records `messages.create(...)` (non-streaming)
  and `messages.stream(...)`, on `client.messages` and `client.beta.messages`, as model spans
  named `turn-N`: model id, request parameters (`max_tokens`, `thinking`, `tool_choice`,
  `output_config`, tool names), content blocks, stop reason and token usage. Streams are recorded
  from their final message while the caller consumes them as usual; `create({ stream: true })`
  returns the raw event stream and is passed through unrecorded. `thinking` blocks become
  `thinking` notes, the system prompt and tool names become context when they change, and a
  failed request is noted as `anthropic.request_failed` and re-thrown. With the default
  `recordMessages: "new"`, a history that was extended in place records only the turns added
  since the previous call (`metadata.anthropic.skippedMessages` says how many were left out);
  `"all"` records the full array every time.
- **`runAnthropicToolLoop(trace, client, { params, tools, guard?, maxTurns? })`** runs the
  tool-use loop on a wrapped client: each `tool_use` block is executed through `trace.tool`, so
  it is a tool span with an optional policy guard, and every result goes back in one user
  message. A tool that throws, is not registered or is blocked by its guard returns an
  `is_error` result so the model can react. `pause_turn` continues the turn, `max_tokens` and
  `refusal` end the loop without running tools, and `maxTurns` (default 20) bounds it. Tools run
  one after another so their spans nest correctly. Code that prefers the Anthropic SDK's own
  tool runner can pass it a wrapped client instead; model calls are then recorded, tool
  executions are not.

The adapter has no dependency on `@anthropic-ai/sdk`: it matches the client structurally and
never calls the API itself. Costs are estimated by the API at ingestion from the built-in price
table (see [cost tracking](../concepts/cost-tracking.md)).

## Importing a conversation

Save the conversation your application already has, the `messages` array it sends to the
Messages API with every assistant turn appended, as JSON and import it:

```bash
shadow import anthropic examples/anthropic-messages/refund-conversation.json
shadow import anthropic messages.json --agent claude-refund-agent --model claude-opus-5-5
```

The file is either a bare `messages` array or an object:

```json
{
  "project": "support",
  "agent": "claude-refund-agent",
  "model": "claude-opus-5-5",
  "system": "You are a customer-support agent…",
  "tools": [{ "name": "lookup_order", "input_schema": {} }],
  "messages": [
    { "role": "user", "content": "My headphones arrived broken." },
    {
      "role": "assistant",
      "content": [{ "type": "tool_use", "id": "toolu_1", "name": "lookup_order", "input": {} }]
    },
    {
      "role": "user",
      "content": [{ "type": "tool_result", "tool_use_id": "toolu_1", "content": "…" }]
    }
  ],
  "responses": [
    {
      "id": "msg_1",
      "stop_reason": "tool_use",
      "usage": { "input_tokens": 412, "output_tokens": 58 }
    }
  ]
}
```

`responses` is optional: one entry per assistant message, in order, carrying what the API
returned next to the content (`stop_reason`, `usage`, `model`, `id`). Without it the stop reason
is inferred (`tool_use` when the turn has `tool_use` blocks, otherwise `end_turn`) and flagged
`metadata.anthropic.stopReasonInferred`, and the turn has no token usage. Everything else
defaults: project `anthropic`, agent `claude-agent`, the trace name is the first user message.

What the importer does today, relative to the mapping below:

- Each assistant message is one model span named `turn-N`. Its `model.request` carries the
  messages added since the previous call (the system prompt on the first), not the whole
  history; the full conversation is the trace's state, appended message by message at
  `/messages/-`, so the state inspector shows the history as of any event.
- `tool_use` blocks open tool spans that the matching `tool_result` blocks of the next user
  message close (`tool.error` when `is_error` is true). Server tools (`server_tool_use` with its
  `*_tool_result` block in the same assistant message) become tool spans flagged
  `metadata.anthropic.server`; an error object in the result becomes `tool.error`.
- `thinking` blocks become `agent.note` events named `thinking` (severity `debug`);
  `redacted_thinking` and thinking returned with empty text are noted as `{ redacted: true }`.
- Token usage follows Shadow's convention: `inputTokens` is the whole prompt (`input_tokens`
  plus cache reads and cache writes, which the API reports separately) and `cachedInputTokens`
  is `cache_read_input_tokens`; cache creation tokens are also kept in
  `metadata.anthropic.usage`. Costs are estimated from the built-in Anthropic price table (see
  [cost tracking](../concepts/cost-tracking.md)).
- The system prompt and tool names are context (`system`, `tools`); a mid-conversation
  `role: "system"` message updates the `system` context.
- The trace ends `completed` with an outcome of `completed`, `truncated` (`max_tokens`),
  `refusal` or `incomplete` (the history ends on a user message or an unanswered tool call).
  The response reports `unmatchedToolUses` and `orphanToolResults` so gaps in a log are visible.
- Timestamps are synthetic: the log has none, so events are one millisecond apart from
  `startedAt` (default: the time of import) and durations are not meaningful.

Imported conversations can be inspected, searched, compared and forked into what-if branches,
but not replayed: there is no program to re-run.

## Goal

Record agent loops built directly on the Anthropic Messages API, where the model returns
`tool_use` content blocks, the application executes tools and returns `tool_result` blocks, and
the loop continues until `end_turn`. Provide both a live wrapper and an importer for message
histories so that an existing conversation log can be inspected and forked.

## Surface

- `traceAnthropic(trace, client)` and `runAnthropicToolLoop(trace, client, options)` in
  `@shadow/sdk` (implemented; see [Recording live calls](#recording-live-calls)). They live in
  the SDK rather than a separate adapter package because they add no dependency.
- `POST /api/v1/import/anthropic` and `shadow import anthropic` for stored histories
  (implemented; see [Importing a conversation](#importing-a-conversation)).
- `recordedModelAdapter(events)` for deterministic replay (proposed; see [Replay](#replay)).

## Mapping

| Messages API concept                                                       | Shadow                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `messages.create` request                                                  | `model.request`: `provider: "anthropic"`, `model` = `model`, `messages` = `system` (as a `system` role message) followed by `messages` with content blocks preserved as JSON, `parameters` = `max_tokens`, `temperature`, `tool_choice`, `thinking`, `tools` (names and schemas)                                                                              |
| Response                                                                   | `model.response`: `message` = `{ role: "assistant", content: <content blocks> }`, `finishReason` = `stop_reason`, `toolCalls` = one entry per `tool_use` block `{ tool: name, arguments: input, id }`, `tokenUsage` = `{ inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, totalTokens, cachedInputTokens: usage.cache_read_input_tokens }` |
| `tool_use` block executed by the application                               | `tool.request` (`name` = tool name, `arguments` = `input`, `metadata.anthropic.toolUseId`) inside the agent span, after the model span                                                                                                                                                                                                                        |
| `tool_result` block                                                        | `tool.response` (`result` = `content`) or `tool.error` when `is_error` is true                                                                                                                                                                                                                                                                                |
| Server tools (web search, code execution, computer use, bash, text editor) | `tool.request` / `tool.response` reconstructed from the paired `server_tool_use` and result blocks, `metadata.anthropic.server = true`                                                                                                                                                                                                                        |
| `thinking` / `redacted_thinking` blocks                                    | Kept inside `model.response.output.message.content`; additionally an `agent.note` named `thinking` with the visible text (severity `debug`) so the timeline shows reasoning steps; redacted blocks are noted without content                                                                                                                                  |
| Streaming events                                                           | Aggregated into one `model.response`; `message_start` / `message_delta` usage merged                                                                                                                                                                                                                                                                          |
| `stop_reason = "max_tokens"`                                               | `model.response` with `finishReason: "max_tokens"` and severity `warn`                                                                                                                                                                                                                                                                                        |
| API error (`APIError`, rate limit, overloaded)                             | `model.response` absent; a `tool.error`-style failure is not appropriate, so the adapter emits `anthropic.request_failed` with status and error type, then `trace.failed` if the loop aborts                                                                                                                                                                  |
| Prompt caching (`cache_control`)                                           | `cachedInputTokens` in `tokenUsage`; cache creation tokens in `metadata.anthropic.usage`                                                                                                                                                                                                                                                                      |
| Batches API                                                                | Out of scope for v0.2                                                                                                                                                                                                                                                                                                                                         |

### Context and state

- Each distinct `system` prompt is recorded once as `context.added` with key `system` (and
  per-agent keys in multi-agent setups) so it can be inspected and, once prompt overrides exist,
  overridden.
- The tool catalogue passed in `tools` is recorded as `context.added` `tools` (names only) at
  the first call and updated on change.
- The conversation history is program state: `state.patch` appends each assistant and user
  message at `/messages/-`, with an automatic `state.snapshot` every N turns. Importers
  reconstruct this from the message array.

### Guards and policies

`runToolLoop` accepts a `guard(toolName, input)` returning a `PolicyCall`; the helper passes it as
the `guard` of `host.tool`, so policy evaluations appear inside the tool span exactly as in the
bundled demo agents, and blocked calls return an `is_error` tool result to the model.

## Replay

Traces recorded through `traceAnthropic` are inspectable and comparable. For deterministic replay
the loop must be expressed as an `AgentProgram`: `runToolLoop` is written so that the same
function can run under the core runtime, where the `ModelAdapter` supplies responses. The adapter
will ship `recordedModelAdapter(events)` that serves recorded responses for identical requests
and fails with a clear error otherwise, which is sufficient to replay forks whose overrides only
affect tools. Model substitution and prompt overrides (v0.4) build on the same program.

## Limitations

- Content blocks are stored verbatim; large image or document blocks are size-capped and
  summarised (type, byte size) until the artifact store has an API.
- Token counts come from the API response; costs are estimates and need a pricing table entry for
  the model used.
- Extended thinking content may be redacted by the API and cannot be reconstructed.

## Open questions

- Whether a `model.response` should be split into one event per content block for very long
  responses.
- How to map multi-agent orchestration patterns (an agent calling another agent as a tool) to
  nested agent spans automatically.
