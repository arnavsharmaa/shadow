# @shadow/sdk

Instrumentation SDK for [Shadow](../../README.md), the time-travel debugger for AI agents. Records model calls, tool calls, policy evaluations, state and context changes as a structured trace and ships them to a Shadow API.

## Install

```bash
pnpm add @shadow/sdk
```

Requires Node.js ≥ 22.12 (uses the global `fetch`). The only dependency is `@shadow/schemas`.

## Usage

```ts
import { Shadow } from "@shadow/sdk";

const shadow = new Shadow({
  project: "support-agent", // created on first use
  agent: "refund-agent",
  endpoint: "http://localhost:4000", // or SHADOW_ENDPOINT
  token: process.env.SHADOW_TOKEN, // only if the API sets SHADOW_API_TOKEN
});

const trace = shadow.startTrace({
  name: "refund-request",
  metadata: { customerId: "cus_1001" },
  tags: ["refund"],
  collections: ["prompt-v3"], // created when missing; trace.collect(name) adds more later
});

// Context = what the agent knows. State = the agent's working document.
trace.context.set("refundLimit", 500);
trace.state.set("/step", "lookup");

const customer = await trace.tool({
  name: "read_customer",
  arguments: { customerId: "cus_1001" },
  execute: async (args) => crm.read(args), // recorded as tool.request / tool.response
});

const answer = await trace.model({
  provider: "openai",
  model: "gpt-4.1",
  messages: [{ role: "user", content: "Is this refundable?" }],
  execute: async (request) => {
    const completion = await openai.chat.completions.create(/* ... */);
    return {
      message: { role: "assistant", content: completion.choices[0].message.content },
      tokenUsage: { inputTokens: 120, outputTokens: 40, totalTokens: 160 },
      estimatedCost: 0.0004, // optional
    };
  },
});

// Guarded tool: the policy is evaluated inside the tool span; a non-allow
// decision throws PolicyBlocked before execute() runs.
try {
  await trace.tool({
    name: "refund_order",
    arguments: { orderId: "ord_5001", amount: 480 },
    guard: {
      policy: "refund.autonomous_limit",
      subject: { amount: 480 },
      evaluate: ({ context }) =>
        480 <= Number(context.refundLimit)
          ? { decision: "allow" }
          : { decision: "approval_required" },
    },
    execute: async (args) => payments.refund(args),
  });
} catch (error) {
  if (error instanceof PolicyBlocked) {
    const approval = await trace.requestApproval({ reason: "refund exceeds autonomous limit" });
    // later: trace.resolveApproval(approval.approvalId, "approved", "lead@example.com");
  }
}

trace.snapshot();
await trace.end({ outcome: { kind: "refunded", label: "Refund issued" } });
await shadow.shutdown();
```

`trace.artifact({ kind, name, content, contentType?, eventId? })` attaches a document (an email
body, a retrieved page, a report) to the trace; use `trace.lastEventId` to link it to the event
that produced it. Artifacts are sent after their events on the next flush.

`trace.tag(...tags)`, `trace.untag(...tags)` and `trace.setMetadata({ key: value })` label a
trace after it has started, for instance with the outcome category or the ticket it resolved.
Changes are coalesced into one `PATCH` sent after the buffered events; `null` deletes a metadata
key and values are redacted like event payloads. Labels applied after `end()` (for example from
the outcome `trace.run()` returned) are sent immediately.

`trace.run(program, input)` runs an `AgentProgram` (the same contract used by Shadow's deterministic replay engine) and ends or fails the trace automatically.

## Anthropic Messages API

`traceAnthropic` wraps an Anthropic client so its calls are recorded without manual spans, and
`runAnthropicToolLoop` runs the tool-use loop with every tool execution recorded:

```ts
import Anthropic from "@anthropic-ai/sdk";
import { Shadow, traceAnthropic, runAnthropicToolLoop } from "@shadow/sdk";

const trace = new Shadow({ project: "support", agent: "claude-agent" }).startTrace({
  name: "ticket-1234",
});
const client = traceAnthropic(trace, new Anthropic());

const { message, messages } = await runAnthropicToolLoop(trace, client, {
  params: { model: "claude-opus-5-5", max_tokens: 16000, tools, messages: history },
  tools: { lookup_order: (input) => lookupOrder(input) },
});
await trace.end();
```

The wrapper returns the client's own type and has no dependency on `@anthropic-ai/sdk`. Details,
options and the event mapping are in
[docs/integrations/anthropic.md](../../docs/integrations/anthropic.md).

## OpenAI API

`traceOpenAI` wraps an OpenAI client so `chat.completions.create` and `responses.create` are
recorded as model spans, streamed or not, with no dependency on the `openai` package, and
`runOpenAIToolLoop` (Chat Completions) and `runOpenAIResponsesLoop` (Responses API) run the
function-calling loop with every tool execution recorded:

```ts
import OpenAI from "openai";
import { Shadow, traceOpenAI, runOpenAIToolLoop } from "@shadow/sdk";

const client = traceOpenAI(trace, new OpenAI());
const { completion } = await runOpenAIToolLoop(trace, client, {
  params: { model: "gpt-5", messages, tools },
  tools: { lookup_order: (input) => lookupOrder(input) },
});
```

Details in [docs/integrations/openai.md](../../docs/integrations/openai.md).

## MCP clients

`traceMcpClient` wraps a Model Context Protocol client so tool calls, resource reads,
catalogue calls and what the server initiates (sampling as a model span, elicitation as an
approval, roots as context, progress and log notifications as notes) are recorded, with no
dependency on the MCP SDK:

```ts
import { Shadow, traceMcpClient } from "@shadow/sdk";

const client = traceMcpClient(trace, mcpClient, { server: "github" });
await client.callTool({ name: "search_issues", arguments: { q: "bug" } }); // a tool span
client.setRequestHandler(CreateMessageRequestSchema, handler); // sampling: a model span
```

Details in [docs/integrations/mcp.md](../../docs/integrations/mcp.md).

## Behaviour

- Events are buffered and flushed every `flushIntervalMs` (default 1000 ms), when `maxBatchSize` events are queued, and on `end()`/`fail()`.
- The HTTP transport retries network errors and 5xx responses with exponential backoff. Failures are reported through `onError` (default: one console warning) and **never throw into agent code**.
- Sensitive keys (`password`, `api_key`, `authorization`, `secret`, `token`, `cookie`, …) are redacted before events leave the process. Add patterns with `redact: { keyPatterns: [...] }` or disable with `redact: false` (the server redacts again).
- A full state snapshot is emitted every `snapshotEvery` mutations (default 25) so state can be reconstructed quickly.
- `sampleRate` (0 to 1, or `SHADOW_SAMPLE_RATE`) records only a fraction of traces; traces started
  with an explicit `id` are sampled deterministically from it. `sampler: (input) => boolean`
  replaces the rate with your own rule, and `startTrace({ sample: true | false })` forces the
  decision for one trace. A sampled-out trace behaves normally but discards its events
  (`trace.recorded === false`). The API can sample too (`SHADOW_INGEST_SAMPLE_RATE`), with the
  same hash of the trace id, so the two agree on which traces to keep.
- `enabled: false` turns the SDK into a no-op; so does `SHADOW_ENABLED=false` (or `0`, `no`,
  `off`) in the environment, which lets a deployment switch recording off without a code change.
- `actor` (or `SHADOW_ACTOR`) names the client in the API's audit log and on the notes and
  artifacts it attaches (`x-shadow-actor`, default `sdk`): a service name or a person.
- `flushOnExit: true` (or `SHADOW_FLUSH_ON_EXIT=true`) flushes every active trace when the
  process is about to exit, so a short-lived script needs no explicit `shutdown()`; a hard
  `process.exit()` still skips it.
- `tags` (or `SHADOW_TAGS=prod,eu`) go on every trace this client starts, ahead of the trace's
  own tags, and `metadata` (a build id, a host name) is merged under the trace's own entries,
  so alert rules scoped to a tag and saved views can tell deployments apart without touching
  every `startTrace` call.
- `webUrl` (or `SHADOW_WEB_URL`), the public base URL of the web app, gives every trace a
  `trace.url`: the page that shows it, ready for a log line or a ticket; `null` when unset.
- `trace.stats` tallies what the trace has recorded so far, in the process and without waiting
  for the API: events, model calls, tool calls and how many failed or were blocked, input,
  output and total tokens, the estimated cost the calls reported and the duration (frozen when
  the trace ends), for a log line, a budget check or a test assertion.
- `shadow.withTrace({ name }, async (trace) => { … })` starts a trace, runs the function with
  it and closes it whichever way the function goes: `end()` when it returns (an `outcome:
(result) => …` option derives the outcome from the result), `fail(error)` when it throws, the
  error then reaching the caller. It resolves to what the function returned, so a handler can
  be wrapped without a `try`/`finally` of its own.
- `budget` on the client or on `startTrace` (`{ maxEstimatedCost, maxTotalTokens, maxModelCalls,
maxToolCalls }`, the trace's limits overriding the client's one by one) caps what a trace may
  spend: once a tally has reached a limit, the next model or tool call throws `BudgetExceeded`
  (with `limit`, `value` and `max`) before it runs, the trace records one `budget.exceeded` note
  and `trace.budgetExceeded` holds the hit, so a runaway loop stops at a known cost instead of
  at the provider's rate limit.
- `project`, `agent`, `endpoint` and `token` default to `SHADOW_PROJECT`, `SHADOW_AGENT`,
  `SHADOW_ENDPOINT` and `SHADOW_TOKEN`, so `new Shadow()` works with environment-only
  configuration.
- `collections` on `startTrace` (or `trace.collect(name)` at any point) puts the trace in named
  collections, creating them when they do not exist, so an experiment's or a nightly run's traces
  are grouped as they are recorded; sent after the events on the next flush. `collections` on
  the client (or `SHADOW_COLLECTIONS=exp-42`) puts every trace it starts in those collections,
  so an experiment run needs no code change.
- `MemoryTransport` keeps events in memory for tests; implement `Transport` for custom destinations.
- `SpoolTransport` records to a newline-delimited JSON file instead of an API, for runs where the
  API is not reachable (CI jobs, batch runs offline): `new Shadow({ transport:
SpoolTransport.toFile("./shadow-spool.ndjson") })`, then `shadow spool send
./shadow-spool.ndjson` replays the records in order. A trace that already exists is skipped
  with its records, so a spool can be sent twice; `parseSpool` reads a spool back. Setting `SHADOW_SPOOL=<path>` (or the `spool` option) does the same without a code change, so a deployment can switch to offline recording the way `SHADOW_ENABLED=false` switches recording off.

## Replay

Traces recorded through the SDK can be inspected, exported and imported. Forking with counterfactual replay requires the agent's program to be registered with the Shadow API; see [docs/concepts/replay-modes.md](../../docs/concepts/replay-modes.md).

## License

Apache-2.0
