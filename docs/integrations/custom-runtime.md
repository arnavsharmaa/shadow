# Custom runtimes

This document describes the two integration paths that exist **today** (v0.1):

1. instrument your agent with `@shadow/sdk`, which implements the `AgentHost` contract and
   streams events to the API;
2. produce a `shadow.trace` bundle from your own runtime's logs and import it.

Both produce traces that can be inspected, forked and compared. Deterministic replay additionally
requires registering the agent as an `AgentDefinition` in the API; see
[Replay modes](../concepts/replay-modes.md#registering-a-replayable-program).

## Path 1: the SDK

### Install and configure

```ts
import { Shadow } from "@shadow/sdk";

const shadow = new Shadow({
  project: "support-agent", // project slug, created on first use
  agent: "refund-agent", // default agent slug
  endpoint: "http://localhost:4000", // or SHADOW_ENDPOINT
  flushIntervalMs: 1000, // 0 disables the timer
  maxBatchSize: 100,
  snapshotEvery: 25, // automatic state.snapshot every N mutations; 0 disables
  redact: { keyPatterns: ["ssn"] }, // extra key patterns; false disables client-side redaction
  onError: (err) => log.warn(err), // transport failures never throw into agent code
});
```

The default transport is `HttpTransport` (batching, 3 attempts with exponential backoff from
250 ms, 10 s timeout, retries on network errors and 5xx). `MemoryTransport` keeps events in
memory for tests and offline recording; any object with `createTrace` and `sendEvents` can be
passed as `transport`.

### Record an execution

```ts
const trace = shadow.startTrace({
  name: "refund-request: ord_5001",
  tags: ["refund"],
  metadata: { ticketId: "TCK-1" },
});

const outcome = await trace.run(
  async (host, input) => {
    host.context.set("customerId", input.customerId);
    host.state.set("/request", input);

    const customer = await host.tool({
      name: "read_customer",
      arguments: { customerId: input.customerId },
      execute: (args) => crm.getCustomer(args.customerId), // your real implementation
    });

    const decision = await host.model({
      provider: "openai",
      model: "gpt-4.1",
      name: "decide",
      messages: [
        { role: "system", content: "…" },
        { role: "user", content: input.message },
      ],
      execute: async (req) => {
        const res = await llm.chat(req);
        return {
          message: { role: "assistant", content: res.text },
          tokenUsage: res.usage,
          finishReason: "stop",
        };
      },
    });

    await host.tool({
      name: "refund_order",
      arguments: { orderId: "ord_5001", amount: 480 },
      guard: {
        policy: "refund.autonomous_limit",
        subject: { amount: 480 },
        evaluate: ({ context }) =>
          480 <= Number(context.refundLimit)
            ? { decision: "allow" }
            : { decision: "approval_required", reason: "over limit" },
      },
      execute: (args) => payments.refund(args),
    });

    return { kind: "refunded", label: "Refund issued" };
  },
  { customerId: "cus_1001", message: "…" },
);

await shadow.shutdown(); // flush before the process exits
```

`trace.run` attaches the input to `agent.started`, ends the trace with the returned outcome
(`trace.completed`, or `trace.failed` when `outcome.kind === "policy_violation"`) and calls
`trace.fail` on exceptions. You can also drive the lifecycle manually with `trace.end({ outcome })`
and `trace.fail(error)`.

Other host methods: `host.policy({ policy, subject, evaluate })` for stand-alone evaluations,
`host.requestApproval({ reason, request })` (records a pending request; call
`trace.resolveApproval(approvalId, "approved" | "rejected", resolvedBy)` when the human decides),
`host.snapshot()`, `host.note(name, data)`, `host.context.*`, `host.state.*`.

Errors thrown by `execute` are recorded as `tool.error` and rethrown as `ToolError` (with
`code`/`retryable` when the original error had them). A guard that does not `allow` records a
`tool.error` with code `policy_blocked` and throws `PolicyBlocked`.

### Wrapping an existing runtime

If your agent already has a tool dispatcher and model client, wrap them once:

```ts
function instrumentedDispatcher(host: AgentHost, dispatcher: Dispatcher): Dispatcher {
  return {
    call: (name, args) =>
      host.tool({ name, arguments: args, execute: (a) => dispatcher.call(name, a) }),
  };
}
```

and map your runtime's state to `host.state` / `host.context` at the points where it changes. The
[mapping principles](./README.md#mapping-principles) apply: known event types for known things,
custom types for the rest, framework payloads in `metadata`.

### Making it replayable

Write the same program without `execute`/`evaluate` callbacks (or with them; deterministic replay
ignores callbacks), package deterministic adapters in an `AgentDefinition`, and register it in
`apps/api/src/replay/registry.ts`. The testkit's `withAdapters(host, adapters)` lets a program
written for adapters run under the SDK with the same adapters, which is how the bundled examples
record and replay the same code.

## Path 2: bundle import

If instrumenting is not possible (a runtime in another language, historical logs), convert your
logs to the `shadow.trace` format and import them:

```bash
shadow traces import ./run-42.shadow.json --regenerate-ids
# or
curl -X POST http://localhost:4000/api/v1/traces/import \
  -H 'content-type: application/json' \
  -d '{ "bundle": <shadow.trace JSON>, "idStrategy": "regenerate" }'
```

The bundle shape is `traceExportSchema` in `packages/schemas/src/api.ts`:

```json
{
  "format": "shadow.trace",
  "schemaVersion": "1.0",
  "exportedAt": "2026-09-03T10:00:00.000Z",
  "project": { "slug": "support-agent", "name": "Support Agent", "description": null, "metadata": {} },
  "agent": { "slug": "refund-agent", "name": "Refund Agent", "description": null, "metadata": {} },
  "trace": { "id": "trc_run42", "projectId": "prj_x", "agentId": "agt_x", "rootBranchId": "br_run42_main",
             "name": "run-42", "status": "completed", "schemaVersion": "1.0",
             "startedAt": "…", "completedAt": "…", "durationMs": 4200, "outcome": { "kind": "refunded", "label": "Refund issued" },
             "tags": [], "metadata": {}, "metrics": {}, "branchCount": 1, "createdAt": "…", "updatedAt": "…" },
  "branches": [ { "id": "br_run42_main", "traceId": "trc_run42", "name": "main", "parentBranchId": null, "forkId": null,
                  "forkEventId": null, "forkSequence": null, "depth": 0, "status": "completed", "outcome": null,
                  "metrics": {}, "createdAt": "…", "updatedAt": "…", "metadata": {} } ],
  "forks": [], "replays": [], "comparisons": [],
  "events": [ … ]
}
```

`projectId`/`agentId` in `trace` are resolved by slug on import (the project and agent are
created if needed); `metrics` are recomputed. Validation requires: `format` and a compatible
`schemaVersion`, every `branchId`/`parentBranchId`/fork reference to resolve, unique event ids,
and strictly increasing sequences per branch. Import with `idStrategy: "regenerate"` unless you
control id uniqueness.

### Worked event mapping

Suppose a runtime logs this (simplified) JSON lines for one run:

```json
{"t":"2026-09-03T10:00:00.000Z","kind":"run_start","input":{"orderId":"ord_5001"}}
{"t":"2026-09-03T10:00:00.100Z","kind":"llm","model":"gpt-4.1","prompt":"Decide…","completion":"Refund it","usage":{"in":120,"out":8}}
{"t":"2026-09-03T10:00:00.900Z","kind":"tool_call","tool":"refund_order","args":{"orderId":"ord_5001","amount":480}}
{"t":"2026-09-03T10:00:01.800Z","kind":"tool_result","tool":"refund_order","result":{"status":"processed"}}
{"t":"2026-09-03T10:00:01.900Z","kind":"memory","key":"lastRefund","value":480}
{"t":"2026-09-03T10:00:02.000Z","kind":"run_end","status":"ok","summary":"Refunded $480"}
```

It maps to these events (all with `traceId: "trc_run42"`, `branchId: "br_run42_main"`,
`schemaVersion: "1.0"`, `source: "import"`, `metadata.shadow.origin: "import"`; fields that are
`null`/`[]`/`{}` by default omitted for brevity):

```json
[
  {
    "id": "evt_0",
    "sequence": 0,
    "timestamp": "2026-09-03T10:00:00.000Z",
    "eventType": "trace.started",
    "name": "run-42",
    "input": { "name": "run-42", "metadata": {} }
  },

  {
    "id": "evt_1",
    "sequence": 1,
    "timestamp": "2026-09-03T10:00:00.000Z",
    "eventType": "agent.started",
    "name": "refund-agent",
    "spanId": "spn_agent",
    "input": { "agent": "refund-agent", "request": { "orderId": "ord_5001" } }
  },

  {
    "id": "evt_2",
    "sequence": 2,
    "timestamp": "2026-09-03T10:00:00.000Z",
    "eventType": "state.patch",
    "name": "/request",
    "spanId": "spn_agent",
    "stateVersion": 1,
    "output": { "ops": [{ "op": "add", "path": "/request", "value": { "orderId": "ord_5001" } }] }
  },

  {
    "id": "evt_3",
    "sequence": 3,
    "timestamp": "2026-09-03T10:00:00.100Z",
    "eventType": "model.request",
    "name": "decide",
    "spanId": "spn_m1",
    "parentSpanId": "spn_agent",
    "input": {
      "provider": "openai",
      "model": "gpt-4.1",
      "messages": [{ "role": "user", "content": "Decide…" }]
    }
  },

  {
    "id": "evt_4",
    "sequence": 4,
    "timestamp": "2026-09-03T10:00:00.900Z",
    "eventType": "model.response",
    "name": "decide",
    "spanId": "spn_m1",
    "parentSpanId": "spn_agent",
    "parentEventId": "evt_3",
    "durationMs": 800,
    "input": { "provider": "openai", "model": "gpt-4.1" },
    "output": {
      "message": { "role": "assistant", "content": "Refund it" },
      "finishReason": "stop"
    },
    "tokenUsage": { "inputTokens": 120, "outputTokens": 8, "totalTokens": 128 }
  },

  {
    "id": "evt_5",
    "sequence": 5,
    "timestamp": "2026-09-03T10:00:00.900Z",
    "eventType": "tool.request",
    "name": "refund_order",
    "spanId": "spn_t1",
    "parentSpanId": "spn_agent",
    "input": { "tool": "refund_order", "arguments": { "orderId": "ord_5001", "amount": 480 } }
  },

  {
    "id": "evt_6",
    "sequence": 6,
    "timestamp": "2026-09-03T10:00:01.800Z",
    "eventType": "tool.response",
    "name": "refund_order",
    "spanId": "spn_t1",
    "parentSpanId": "spn_agent",
    "parentEventId": "evt_5",
    "durationMs": 900,
    "input": { "tool": "refund_order", "arguments": { "orderId": "ord_5001", "amount": 480 } },
    "output": { "result": { "status": "processed" } }
  },

  {
    "id": "evt_7",
    "sequence": 7,
    "timestamp": "2026-09-03T10:00:01.900Z",
    "eventType": "context.added",
    "name": "lastRefund",
    "spanId": "spn_agent",
    "stateVersion": 2,
    "output": { "key": "lastRefund", "value": 480 }
  },

  {
    "id": "evt_8",
    "sequence": 8,
    "timestamp": "2026-09-03T10:00:02.000Z",
    "eventType": "agent.completed",
    "name": "refund-agent",
    "spanId": "spn_agent",
    "durationMs": 2000,
    "output": {
      "outcome": { "kind": "refunded", "label": "Refund issued", "summary": "Refunded $480" }
    }
  },

  {
    "id": "evt_9",
    "sequence": 9,
    "timestamp": "2026-09-03T10:00:02.000Z",
    "eventType": "trace.completed",
    "name": "trace.completed",
    "output": {
      "outcome": { "kind": "refunded", "label": "Refund issued", "summary": "Refunded $480" }
    }
  }
]
```

Decisions made in the mapping:

- `run_start` became three events: the trace start, the agent span opener with the request, and
  a `state.patch` so the input is visible in the state inspector.
- `llm` became an opener/closer pair sharing `spn_m1`; the closer points at the opener with
  `parentEventId` and carries duration and token usage. `estimatedCost` was left `null` because
  the runtime had no pricing information.
- `tool_call`/`tool_result` became a tool span; a failed result would have been a `tool.error`
  with `severity: "error"`.
- `memory` became `context.added` because it is a fact the agent later relies on; structured
  working data would have gone to `state.patch` instead.
- The runtime's own fields (`kind`, raw lines) could be kept under `metadata.myruntime` on each
  event.

After import, the trace can be explored, its state reconstructed at every event, forked at the
`refund_order` request and compared, but not replayed until a program is registered.

### Sending events live instead of a bundle

The same events can be sent incrementally: `POST /api/v1/traces` to create the trace, then
`POST /api/v1/traces/:traceId/events` with batches of `IngestEvent`s (ids, sequences and
timestamps optional). This is exactly what the SDK's `HttpTransport` does, and it is the easiest
way to write an SDK for another language.
