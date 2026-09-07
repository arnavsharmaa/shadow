# OpenAI Agents SDK integration

> **Status: design proposal for v0.2. Not implemented in v0.1.** The mapping is presented for
> review and may change. Until an adapter exists, agents built with the OpenAI Agents SDK can be
> recorded by wrapping tool and model calls with `@shadow/sdk` as described in
> [custom-runtime.md](./custom-runtime.md).

## Goal

Record runs of agents built with the OpenAI Agents SDK (TypeScript first; Python once a Python
SDK exists) as Shadow traces, including handoffs between agents, tool calls, guardrails and the
run context, and make simple runs replayable deterministically.

## Proposed surface

```ts
import { Shadow } from "@shadow/sdk";
import { withShadow } from "@shadow/adapter-openai-agents";

const shadow = new Shadow({ project: "support", agent: "triage" });
const result = await withShadow(shadow, { name: "ticket-1234" }, () => run(triageAgent, input));
```

`withShadow` installs a trace processor (the SDK's tracing hooks) for the duration of the run and
maps the SDK's spans to Shadow events on one `Trace`. An alternative `ShadowTraceProcessor` can be
registered globally for long-running services.

## Mapping

| Agents SDK concept                                   | Shadow                                                                                                                                                                                                                                   |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run(agent, input)` (a run / trace)                  | One Shadow trace: `trace.started` (input in `agent.started.input.request`), `trace.completed` / `trace.failed`                                                                                                                           |
| Agent span (`agent_span`)                            | `agent.started` / `agent.completed` with `name` = agent name; nested agents nest spans                                                                                                                                                   |
| Handoff (`handoff_span`)                             | `agent.completed` for the source agent (output `{ outcome: { kind: "handoff", label } }`), then `agent.started` for the target as a sibling span, plus a custom `openai_agents.handoff` event with `{ from, to, reason? }` in `metadata` |
| Generation span (`generation_span`, `response_span`) | `model.request` (`provider: "openai"`, `model`, `messages` from the input items, `parameters` from model settings) / `model.response` (output message, `toolCalls` from function-call items, `tokenUsage` from usage, `finishReason`)    |
| Function tool call (`function_span`)                 | `tool.request` (`name` = tool name, arguments parsed from the JSON string) / `tool.response` (`result` parsed if JSON, else string) or `tool.error`                                                                                      |
| Hosted tools (web search, file search, computer use) | `tool.request` / `tool.response` with `metadata.openai_agents.hosted = true`; results as returned by the API                                                                                                                             |
| MCP tools invoked through the SDK                    | `tool.request` / `tool.response` with `metadata.mcp.server`; see [mcp.md](./mcp.md)                                                                                                                                                      |
| Input guardrail                                      | `policy.evaluated` with `policy` = `guardrail:<name>`, `subject` = the input, decision `deny` when tripwire triggered, else `allow`; followed by `policy.denied` / `policy.allowed`                                                      |
| Output guardrail                                     | Same, evaluated inside the agent span after the final output                                                                                                                                                                             |
| Guardrail tripwire exception                         | `trace.failed` with `outcome.kind = "policy_violation"`                                                                                                                                                                                  |
| Run context (`context` object)                       | Initial snapshot as `context.added` per top-level key at `agent.started`; changes detected between turns are emitted as `context.added` / `context.removed`                                                                              |
| Agent instructions (system prompt)                   | `context.added` with key `instructions:<agent>` (so forks can override prompts once prompt overrides exist) and as the system message of each `model.request`                                                                            |
| Conversation items between turns                     | `state.patch` on `/items` (appended), with an automatic `state.snapshot` per turn                                                                                                                                                        |
| Final output                                         | `agent.completed.output.outcome = { kind: "completed", label: <summary> }`; structured outputs stored at `state./finalOutput`                                                                                                            |
| Max turns exceeded / other run errors                | `trace.failed` with `error.code` = the SDK error class name                                                                                                                                                                              |
| Custom spans (`custom_span`)                         | `openai_agents.custom` events with the span data in `output`                                                                                                                                                                             |

Trace and span ids from the SDK are kept in `metadata.openai_agents.traceId` / `spanId`.

## Replay

Recording alone gives historical inspection and comparison. For deterministic replay the adapter
would provide `defineReplayableAgent(agent, { tools, model })`, producing an `AgentDefinition`
whose program drives the SDK's run loop with:

- a `ModelAdapter` that returns scripted responses (or, later, recorded responses when the request
  matches), and
- `MockToolAdapter` entries for each function tool.

This is feasible when the run loop is deterministic given model and tool results, which is the
case for function tools but not for hosted tools or computer use. Replay support will initially
cover function-tool agents only.

## Limitations

- Streaming runs are recorded at item granularity, not token granularity.
- Hosted tool internals (search results ranking, computer-use actions) are opaque; only inputs
  and outputs are recorded.
- Token usage is available per response; costs remain estimates and require a pricing table for
  the model in use.
- Parallel tool calls within one turn are recorded in completion order; `sequence` reflects
  observation order, not causal independence.

## Open questions

- Whether handoffs should be modelled as nested agent spans (call semantics) or sibling spans
  (transfer semantics). The proposal uses siblings, which matches the SDK's semantics.
- How to map `RunConfig` model overrides and tracing metadata to trace tags.
