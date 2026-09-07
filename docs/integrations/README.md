# Integrations

Shadow is vendor neutral: its event model describes what an agent did (asked a model, called a
tool, evaluated a policy, changed what it knows) rather than how any particular framework
organises that work. Integrations map a framework's execution model onto that event model.

## Status

| Integration                                       | Status                              | Document                                       |
| ------------------------------------------------- | ----------------------------------- | ---------------------------------------------- |
| Custom runtime via `@shadow/sdk` or bundle import | **Available in v0.1**               | [custom-runtime.md](./custom-runtime.md)       |
| OpenTelemetry / OTLP                              | Proposal for v0.2 (not implemented) | [opentelemetry.md](./opentelemetry.md)         |
| OpenAI Agents SDK                                 | Proposal for v0.2 (not implemented) | [openai-agents-sdk.md](./openai-agents-sdk.md) |
| LangGraph                                         | Proposal for v0.2 (not implemented) | [langgraph.md](./langgraph.md)                 |
| Model Context Protocol (MCP)                      | Proposal for v0.2 (not implemented) | [mcp.md](./mcp.md)                             |
| Anthropic tool-use traces                         | Proposal for v0.2 (not implemented) | [anthropic.md](./anthropic.md)                 |

Proposals describe the intended mapping so they can be reviewed before code is written. They may
change; nothing in them is a commitment to a specific API surface. Requests for other frameworks
go through the [integration request](../../.github/ISSUE_TEMPLATE/integration_request.yml)
issue template.

## Mapping principles

1. **Map to meaning, not to structure.** A framework "node", "step", "run" or "span" becomes a
   Shadow event only if it corresponds to something Shadow reasons about: a model call, a tool
   call, a policy decision, a human approval, a state or context mutation, an outcome. Purely
   structural containers become spans (`spanId`/`parentSpanId`) or `metadata`, or are dropped.
2. **Use the known event types for known things.** A model invocation is always
   `model.request`/`model.response`, a tool invocation always `tool.request`/`tool.response`/
   `tool.error`, regardless of what the framework calls them. That is what makes the execution
   tree, cost tracking, tool diffs and fork points work without per-framework code.
3. **Add framework-specific types for framework-specific things.** Use your own
   `category.action` types (`langgraph.node_entered`, `mcp.resource_read`) for concepts with no
   Shadow equivalent. They are stored, displayed and preserved on export; the engine treats them
   as inert.
4. **Preserve the original.** Put the framework's raw payload, ids and attributes in `metadata`
   (not under `metadata.shadow`, which is reserved) so nothing is lost and future mappings can be
   improved.
5. **Model state and context explicitly.** Shadow cannot infer what an agent "knows". Map the
   framework's state (graph channels, run context, memory) to `state.patch` /
   `context.added` events, and emit `state.snapshot` at natural checkpoints. Without this,
   forks can still be created but overrides have nothing to target.
6. **Keep spans consistent.** Openers (`model.request`, `tool.request`, `agent.started`) create
   a `spanId`; closers share it and point back with `parentEventId`; nested work inside a span
   carries that `spanId`. See [Events](../concepts/events.md#spans-and-hierarchy).
7. **Costs are estimates.** Record `tokenUsage` when the framework exposes it; leave
   `estimatedCost` null unless a pricing table is available. Never invent numbers.
8. **Redact before sending.** Integrations run in user processes; use the SDK's redactor (or
   your own) so credentials never reach the API.
9. **Be honest about replayability.** An integration that only _records_ produces traces that
   can be inspected and compared (historical replay). Deterministic replay additionally needs a
   registered program and deterministic adapters; say which you provide.

## The `AgentHost` contract

`packages/schemas/src/host.ts` defines the interface an agent program uses to interact with the
world through Shadow. The same program runs unchanged under the SDK (live recording), the core
recording runtime (seeds, tests) and the replay runtime.

```ts
interface AgentHost {
  readonly traceId: string;
  readonly branchId: string;
  readonly mode: "record" | "replay";
  readonly context: ContextAccessor; // get/has/set/remove/all
  readonly state: StateAccessor; // get/at/set/remove/replace
  tool(call: ToolCall): Promise<JsonValue>;
  model(call: ModelCall): Promise<ModelResult>;
  policy(call: PolicyCall): Promise<PolicyEvaluation>;
  requestApproval(request: ApprovalRequest): Promise<ApprovalResolution>;
  snapshot(): void;
  note(name: string, data?: JsonValue): void;
}

type AgentProgram<Input> = (host: AgentHost, input: Input) => Promise<Outcome | void>;
```

- `ToolCall { name, arguments, execute?, guard?, tags?, metadata? }`: `execute` is the live
  implementation (ignored by deterministic replay); `guard` is a `PolicyCall` evaluated inside
  the tool span before execution.
- `ModelCall { provider, model, messages, parameters?, name?, execute?, tags?, metadata? }` and
  `ModelResult { message, finishReason?, toolCalls?, tokenUsage?, latencyMs?, estimatedCost? }`.
- `PolicyCall { policy, subject, evaluate?, config? }` returning a `PolicyEvaluation` with a
  decision of `allow`, `deny` or `approval_required`.

Framework adapters have two ways to plug in:

- **Wrap the framework with the host.** Intercept the framework's model, tool and state hooks and
  forward them to `host.model`, `host.tool`, `host.state`, `host.context`. This yields traces of
  full fidelity and, if the framework's execution is deterministic given the host's answers, a
  replayable program.
- **Translate the framework's own telemetry.** Convert callbacks, OTLP spans or run logs into
  Shadow events and send them through the ingestion API or as a bundle. This is the pragmatic
  route for frameworks whose internals cannot be intercepted; the result is inspectable and
  comparable but not replayable.

## Deterministic adapters

For replay, an `AgentDefinition` (`packages/core/src/runtime/types.ts`) provides
`createAdapters({ seed })` returning:

```ts
interface Adapters {
  model: ModelAdapter; // complete(request, ctx) -> ModelResult
  tools: ToolAdapter; // execute({ tool, arguments }, ctx) -> ToolResult
  policies: PolicyAdapter; // evaluate({ policy, subject }, ctx) -> PolicyResult
  approvals?: ApprovalAdapter; // request(request, ctx) -> ApprovalResolution
}
```

`ctx` carries the current `context`, `state` and virtual `now`; tool contexts also carry the
1-based `occurrence`. Reference implementations live in `@shadow/testkit`
(`ScriptedModelAdapter`, `MockToolAdapter`, `RuleBasedPolicyAdapter`, `pendingApprovals`,
`approvingAfter`). Adapters must be pure functions of their inputs and the seed.

## How future adapters plug in

The intended shape for v0.2 adapters:

- Each adapter is a workspace package `packages/adapter-<name>` depending on `@shadow/schemas`
  (and `@shadow/sdk` for recording). It exports:
  - a recorder: `record<Framework>(shadow, runInput, options)` or an instrumentation hook that
    produces `IngestEventInput[]` through a `Trace`;
  - optionally a mapper from the framework's native trace format to a `shadow.trace` bundle for
    offline import;
  - optionally an `AgentDefinition` factory when the framework's runtime can be driven
    deterministically through `Adapters`.
- Ingestion adapters that accept a foreign wire format (OTLP) live in `apps/api` behind their own
  route prefix and reuse the ingestion service.
- Every adapter ships a mapping document in this directory, an example under `examples/`, and
  conformance tests that assert the produced events validate against `@shadow/schemas` and build
  a well-formed execution tree.
