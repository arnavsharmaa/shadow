# Model Context Protocol (MCP) tracing

> **Status: the client wrapper is implemented** as `traceMcpClient` in `@shadow/sdk`, including
> what the server initiates (sampling, elicitation, roots, notifications) through the handlers
> the host registers. Replay helpers remain proposals; see [What is recorded](#what-is-recorded).

## Using it

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Shadow, traceMcpClient } from "@shadow/sdk";

const shadow = new Shadow({ project: "ops", agent: "runbook-agent" });
const trace = shadow.startTrace({ name: "incident-4471" });
const client = traceMcpClient(trace, new Client({ name: "runbook", version: "1.0.0" }), {
  server: "github",
});
await client.connect(transport);
const result = await client.callTool({ name: "search_issues", arguments: { q: "bug" } });
```

The wrapper returns the client's own type and has no dependency on `@modelcontextprotocol/sdk`:
it matches the client structurally, so any object with the same method names works.

### What is recorded

- `callTool` is a tool span named `<server>/<tool>` (`qualifyToolNames: false` keeps the bare
  name) with the call's arguments, the result's `content` and `structuredContent`, and
  `metadata.mcp.server` / `metadata.mcp.tool`. A result with `isError` is recorded as
  `tool.error` (`code: "mcp_tool_error"`, message from the text content) and still returned to
  the caller, as the client would; a transport failure is recorded as `tool.error` and
  re-thrown. A `guard` option evaluates a policy inside the span before the call reaches the
  server, so a denied call never leaves the process.
- `readResource` is a tool span named `resource:<uri>` whose result is the `contents`; `text`
  and `blob` fields longer than `resourceContentLimit` (default 64 KiB) are cut and flagged
  `truncated` with their original length.
- `connect` adds an `mcp.session_started` note with the server's info and capabilities;
  `listTools` adds `mcp.tools_listed` and records the tool names as context
  (`mcp.tools:<server>`), so a fork can change what the agent believes is available;
  `listResources`, `listPrompts` and `getPrompt` add `mcp.resources_listed`,
  `mcp.prompts_listed` and `mcp.prompt_retrieved` notes.
- `setRequestHandler(schema, handler)` wraps the handler the host registers for a request the
  server sends. The method is read from the schema's `method` literal (Zod 3 and 4 shapes are
  both matched; a schema without one leaves the handler untouched):
  - `sampling/createMessage` is a model span (`model.request` / `model.response`) named
    `sampling:<server>` with `provider: "mcp"`, the model from the server's first hint (or
    `host`), the system prompt and messages as model messages, the remaining params (`maxTokens`,
    `modelPreferences`, …) as parameters, `metadata.mcp.initiatedBy = "server"`, and the
    handler's `content`, `role` and `stopReason` as the response;
  - `elicitation/create` is `human.approval_requested` with the message as the reason and the
    requested schema as the request, resolved `approved` on `accept` and `rejected` on
    `decline` or `cancel`, with the user's answer kept at `state./elicitations/<approvalId>`;
  - `roots/list` records the roots the handler returns as context `mcp.roots`;
  - any other request becomes an `mcp.server_request` note with its params and result.
- `setNotificationHandler(schema, handler)` records the notification before the host's handler
  sees it: `notifications/progress` as a `progress:<token>` note (progress, total, message),
  `notifications/message` as an `mcp.log` note whose severity follows the log level (`warning`
  → `warn`, `error` and above → `error`, otherwise `info`), the `tools`, `resources` and
  `prompts` `list_changed` notifications as `mcp.catalog_changed`, `resources/updated` as
  `mcp.resource_updated`, and anything else as `mcp.notification`.
- Everything else (`ping`, `close`, …) passes through untouched.

Elicitation and sampling are recorded from the host side: the server's reasoning is opaque, and
the model the host actually used for a sampling request is not reported by the MCP result
beyond its name, so the span's model is the server's preference.

## Goal

Record the interaction between an MCP host (the agent application) and MCP servers: tool calls,
resource reads, prompt retrievals, sampling requests and elicitation, with enough detail to fork
an execution at a tool call and override the server's response.

MCP is a transport for tools, not an agent runtime, so the integration is a **client wrapper**
rather than a framework adapter: it sits between the agent and the MCP client and observes
requests and responses.

## Surface

```ts
import { Shadow } from "@shadow/sdk";
import { traceMcpClient } from "@shadow/adapter-mcp";

const shadow = new Shadow({ project: "ops", agent: "runbook-agent" });
const trace = shadow.startTrace({ name: "incident-4471" });
const client = traceMcpClient(trace, new Client({ name: "runbook", version: "1.0.0" }), {
  server: "github",
});
```

`traceMcpClient` returns a client with the same interface; every request becomes Shadow events
on the trace. A server-side middleware for MCP servers written in TypeScript is a possible later
addition for recording from the server's point of view.

## Mapping

| MCP request / notification                                   | Shadow                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `initialize` / capabilities exchange                         | `mcp.session_started` event with server info and capabilities in `output`; server name in `metadata.mcp.server` on every subsequent event                                                                                                                                                                 |
| `tools/list`                                                 | `mcp.tools_listed` with the tool catalogue in `output` (schemas retained for the fork editor)                                                                                                                                                                                                             |
| `tools/call`                                                 | `tool.request` (`name` = `<server>/<tool>` or plain tool name per configuration, `arguments` from the request) / `tool.response` (`result` = `content` array and `structuredContent` when present) or `tool.error` when `isError` is true or the transport fails (`code` = JSON-RPC error code as string) |
| `resources/read`                                             | `mcp.resource_read` custom span: `mcp.resource_read` opener (`input: { uri }`) and closer with `contents` in `output`; large blobs summarised (size, mime type) with the payload under a configurable size cap                                                                                            |
| `resources/list`, `resources/templates/list`                 | `mcp.resources_listed`                                                                                                                                                                                                                                                                                    |
| `prompts/get`                                                | `mcp.prompt_retrieved` with the messages in `output`; if the messages are then sent to a model, that call is a normal `model.request`                                                                                                                                                                     |
| `sampling/createMessage` (server asks host for a completion) | `model.request` / `model.response` with `metadata.mcp.initiatedBy = "server"` and the server name; `provider`/`model` from the host's model selection                                                                                                                                                     |
| `elicitation/create` (server asks the user)                  | `human.approval_requested` with the elicitation message as `reason` and the schema as `request`; the user's response -> `human.approval_resolved` (`approved` on accept, `rejected` on decline/cancel) with the submitted content at `state./elicitations/<id>`                                           |
| `notifications/progress`                                     | `agent.note` with `name` = `progress:<token>`                                                                                                                                                                                                                                                             |
| `notifications/message` (server log)                         | `agent.note` with severity from the log level                                                                                                                                                                                                                                                             |
| `notifications/tools/list_changed`, `resources/list_changed` | `mcp.catalog_changed`                                                                                                                                                                                                                                                                                     |
| Roots (`roots/list`)                                         | `context.added` with key `mcp.roots`                                                                                                                                                                                                                                                                      |
| Transport errors, timeouts                                   | `tool.error` (`retryable: true` for timeouts)                                                                                                                                                                                                                                                             |

JSON-RPC ids are stored in `metadata.mcp.requestId`; the session id in `metadata.mcp.sessionId`.
Every event carries `spanId` of the enclosing agent or tool span so MCP calls nest correctly
under the agent's current step.

### State and context

MCP itself has no agent state. The wrapper records the server catalogue and roots as context,
so a fork can, for example, remove a tool from what the agent believes is available. Application
state must be recorded by the agent through the host as usual.

## Overrides and replay

The most useful counterfactual for MCP is "what if the server had returned something else":

- `tool_result` and `tool_error` overrides apply directly to MCP tool calls by tool name and
  occurrence.
- A future `resource` override kind (proposed) would substitute `resources/read` contents.

Deterministic replay of an MCP-using agent requires the agent's program to be registered with a
`ToolAdapter` that answers MCP tool names; the wrapper will offer `recordedServerAdapter(trace)`
that serves recorded responses for unchanged calls as a starting point for such adapters.

## Limitations

- Binary resource contents are stored under a size cap; larger payloads will use the artifact
  store once it has an API.
- Sampling requests initiated by servers are recorded from the host side only; the server's
  reasoning is opaque.
- Streaming (SSE) transports are recorded at message granularity.

## Open questions

- Tool naming: qualify with the server name (`github/create_issue`) by default, or keep the raw
  tool name and rely on `metadata.mcp.server`?
- Whether `mcp.resource_read` should be a known event type with a typed payload.
