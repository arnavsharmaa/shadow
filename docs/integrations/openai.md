# OpenAI API tracing

> **Status: implemented** as `traceOpenAI` in `@shadow/sdk` for the Chat Completions and
> Responses APIs. An adapter for the OpenAI Agents SDK (runs, handoffs, guardrails) remains a
> proposal; see [openai-agents-sdk.md](./openai-agents-sdk.md).

## Using it

```ts
import OpenAI from "openai";
import { Shadow, traceOpenAI } from "@shadow/sdk";

const shadow = new Shadow({ project: "support", agent: "gpt-agent" });
const trace = shadow.startTrace({ name: "ticket-1234" });
const client = traceOpenAI(trace, new OpenAI());

const completion = await client.chat.completions.create({
  model: "gpt-5",
  messages: history,
  tools,
});
// ...run the tools the model asked for through trace.tool(...), append the results, repeat...
await trace.end();
```

The wrapper returns the client's own type and has no dependency on the `openai` package: the
client is matched structurally, so any object with the same method names works. The `beta`
namespace is wrapped the same way.

## What is recorded

- `chat.completions.create` is a model span (`model.request` / `model.response`) with
  `provider: "openai"`, the model id, the messages, the request parameters worth keeping
  (`temperature`, `max_completion_tokens`, `tool_choice`, `response_format`,
  `reasoning_effort`, …, and the tool names), the assistant message as returned, the tool calls
  with their JSON `arguments` parsed, the finish reason and the token usage. Cached prompt tokens
  (`prompt_tokens_details.cached_tokens`) are reported as `cachedInputTokens`; OpenAI counts them
  inside `prompt_tokens`, which is what `inputTokens` carries.
- `responses.create` is recorded the same way: the `input` items are the messages (a string
  input is one user message, `instructions` the system message), the `output` items are the
  assistant content, `function_call` items are the tool calls, and `reasoning` summaries become
  `reasoning` notes. The finish reason is the response status, or `tool_calls` when the model
  asked for functions.
- **Streaming**: with `stream: true` the wrapper hands the stream to the caller untouched and
  records the span once the stream has been consumed, from the folded chunks (chat; include
  `stream_options: { include_usage: true }` to get token usage) or from the terminal
  `response.completed` / `response.incomplete` / `response.failed` event (responses). A stream
  the caller abandons early is recorded with what had arrived. The promise returned for a
  streamed call is a plain promise, so the SDK's `withResponse()` helper is not available on it.
- The system or developer message, the `instructions` and the tool names are recorded as
  context (`system`, `tools`) when they change, so a fork can edit them.
- `recordMessages: "new"` (default) records only the messages or input items appended since the
  previous call when the same array was extended in place, which keeps long loops linear in
  size; `"all"` records everything on every call. `metadata.openai` carries the API used, the
  history length and how many earlier items were skipped.
- A failed request is noted as `openai.request_failed` (message, error name, HTTP status) and
  re-thrown.

## Tool loop

`runOpenAIToolLoop` runs the Chat Completions function-calling loop on a wrapped client: it
calls the model, executes the function tools it asks for through `trace.tool(...)` (so each is a
tool span, with an optional policy `guard`), appends one `tool` message per call and repeats
until the model stops asking or `maxTurns` (default 20) is reached. A tool that throws, is
unknown or is blocked by its guard answers with a JSON `{ "error": ... }` result so the model
can react. Tool arguments are parsed from their JSON string when they parse.

```ts
const { completion, messages } = await runOpenAIToolLoop(trace, client, {
  params: { model: "gpt-5", messages: history, tools },
  tools: { lookup_order: (input) => lookupOrder(input) },
  guard: (tool) => (tool === "refund_order" ? refundPolicy : undefined),
});
```

`runOpenAIResponsesLoop` does the same for the Responses API: it calls the model with the item
list, appends the output items, runs every `function_call` item through `trace.tool`, appends
one `function_call_output` item per call and repeats until the model stops calling functions,
the response is not `completed` (for example `incomplete`) or `maxTurns` is reached. A string
`input` becomes one user item; the whole item list is resent each turn, so pass
`previous_response_id` handling of your own if you want the server to keep the conversation.

## Importing a conversation

Conversations recorded elsewhere (a log of the `messages` array as sent to Chat Completions,
including the assistant turns with their `tool_calls` and the `tool` messages that answered
them) can be imported as traces:

```bash
shadow import openai examples/openai-chat/refund-conversation.json
# or: POST /api/v1/import/openai with the same JSON
```

The file is either a `messages` array or an object with `messages` plus the optional `tools`,
`model`, `project` (default `openai`), `agent` (default `gpt-agent`), `name`, `tags`,
`metadata`, `startedAt` and `responses` (per assistant turn, in order: `finish_reason`,
`usage`, `model`, `id`). Each assistant message becomes a model span whose request carries the
messages added since the previous call (the whole history is the trace's state at `/messages`),
`tool_calls` open tool spans that the matching `tool` messages close (a `tool` message whose
content is `{"error": "..."}` closes its span as `tool.error`, which is what `runOpenAIToolLoop`
sends), `system` and `developer` messages are recorded as the `system` context, and the
outcome follows the last finish reason (`length` is truncated, `content_filter` a refusal, a
pending tool call or a trailing user message incomplete). The response reports the turns, tool
calls, unmatched calls and orphan results. Imported traces can be forked and compared like any
other; replay needs a registered program.

## Costs

Shadow's built-in price table covers current OpenAI models (`gpt-5` and its mini and nano
variants, `gpt-4.1` and variants, `gpt-4o`, `gpt-4o-mini`, `o3`, `o3-mini`, `o4-mini`, with
cached-input rates; snapshot ids such as `gpt-4o-2024-08-06` resolve to them), so recorded
calls are priced at ingestion. Other models are estimated once the deployment supplies their
prices through `SHADOW_PRICING_FILE` (see [cost tracking](../concepts/cost-tracking.md)).

## Limitations

- Only the first choice of a chat completion (`n > 1`) is recorded.
- Audio, image and file inputs are recorded as the JSON the caller sent; large payloads are not
  capped by the wrapper (the API caps event size).
