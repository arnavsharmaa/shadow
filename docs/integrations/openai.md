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

The Responses API has no loop helper yet; run its `function_call` items through `trace.tool`
and send `function_call_output` items back.

## Costs

Shadow's built-in price table covers Anthropic models. OpenAI calls record token usage, and
costs are estimated when the deployment supplies prices for the models in use through
`SHADOW_PRICING_FILE` (see [cost tracking](../concepts/cost-tracking.md)).

## Limitations

- Only the first choice of a chat completion (`n > 1`) is recorded.
- Audio, image and file inputs are recorded as the JSON the caller sent; large payloads are not
  capped by the wrapper (the API caps event size).
