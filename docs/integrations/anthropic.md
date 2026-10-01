# Anthropic tool-use traces

> **Status: the importer for stored message histories is implemented** (`POST
/api/v1/import/anthropic`, `shadow import anthropic <file>`). The live wrapper
> (`traceAnthropic`, `runToolLoop`) and deterministic replay are still a design proposal; until
> then, live Messages API calls can be recorded by wrapping them with `trace.model()` and
> executing tool calls through `trace.tool()` (see [custom-runtime.md](./custom-runtime.md)).

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
- `usage.cache_read_input_tokens` becomes `cachedInputTokens`; cache creation tokens go to
  `metadata.anthropic.usage`.
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

## Proposed surface

```ts
import Anthropic from "@anthropic-ai/sdk";
import { Shadow } from "@shadow/sdk";
import { traceAnthropic } from "@shadow/adapter-anthropic";

const shadow = new Shadow({ project: "support", agent: "claude-refund-agent" });
const trace = shadow.startTrace({ name: "ticket-1234" });
const client = traceAnthropic(trace, new Anthropic());
// client.messages.create(...) is recorded; the tool loop helper records tool execution
```

Two entry points:

- `traceAnthropic(trace, client)`: wraps `messages.create` (and streaming) so each call is a
  model span.
- `runToolLoop(trace, client, { tools, executeTool, guard? })`: a small helper that runs the
  standard tool-use loop through the host, recording tool calls as tool spans with optional
  policy guards.
- `importMessages(messages, options)`: converts a stored `messages[]` array (plus optional
  response metadata) into a `shadow.trace` bundle for offline import.

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
