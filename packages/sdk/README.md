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
key and values are redacted like event payloads.

`trace.run(program, input)` runs an `AgentProgram` (the same contract used by Shadow's deterministic replay engine) and ends or fails the trace automatically.

## Behaviour

- Events are buffered and flushed every `flushIntervalMs` (default 1000 ms), when `maxBatchSize` events are queued, and on `end()`/`fail()`.
- The HTTP transport retries network errors and 5xx responses with exponential backoff. Failures are reported through `onError` (default: one console warning) and **never throw into agent code**.
- Sensitive keys (`password`, `api_key`, `authorization`, `secret`, `token`, `cookie`, …) are redacted before events leave the process. Add patterns with `redact: { keyPatterns: [...] }` or disable with `redact: false` (the server redacts again).
- A full state snapshot is emitted every `snapshotEvery` mutations (default 25) so state can be reconstructed quickly.
- `enabled: false` turns the SDK into a no-op.
- `MemoryTransport` keeps events in memory for tests; implement `Transport` for custom destinations.

## Replay

Traces recorded through the SDK can be inspected, exported and imported. Forking with counterfactual replay requires the agent's program to be registered with the Shadow API; see [docs/concepts/replay-modes.md](../../docs/concepts/replay-modes.md).

## License

Apache-2.0
