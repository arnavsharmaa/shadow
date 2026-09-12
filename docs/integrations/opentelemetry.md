# OpenTelemetry (OTLP) integration

> **Status: OTLP/HTTP JSON ingestion is implemented** (`POST /api/v1/otlp/v1/traces`); the
> mapping below is what the importer does today. Not yet implemented: the protobuf encoding,
> OTLP/gRPC, the reverse exporter, and the `shadow.state.*` span events. Traces imported this way
> can be inspected, searched, exported and compared, but not forked and replayed (there is no
> program to re-run).

## Using it

Point an OTLP/HTTP exporter at the API with the JSON encoding, for example with the
OpenTelemetry JavaScript SDK:

```ts
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

const exporter = new OTLPTraceExporter({
  url: "http://localhost:4000/api/v1/otlp/v1/traces",
  headers: { authorization: "Bearer <SHADOW_API_TOKEN>" }, // only when the API requires a token
});
```

Environment-based configuration works too: `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:4000/api/v1/otlp/v1/traces`
with `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`. Each request returns the OTLP success envelope
plus a `shadow` object listing the traces it created or extended:

```json
{
  "partialSuccess": {},
  "shadow": {
    "traces": [
      {
        "traceId": "trc_otel_4bf9…",
        "otelTraceId": "4bf9…",
        "created": true,
        "accepted": 14,
        "skipped": 0
      }
    ]
  }
}
```

Resource attribute `service.namespace` selects the project (default
`SHADOW_OTLP_DEFAULT_PROJECT`, `otel`) and `service.name` the agent. Imported traces are tagged
`otel`, every event has `source: "otlp"` and `metadata.otel` keeps the span id, kind, scope,
attributes and status. Spans re-sent by a retrying exporter are ignored by id; spans that arrive
after the root span was stored are appended and flagged `metadata.otel.late`.

## Goal

Accept OpenTelemetry traces, in particular spans that follow the
[GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/), and turn them
into Shadow traces so that agents already instrumented with OpenTelemetry (directly or through a
framework) can be inspected and compared without changing code. A reverse exporter (Shadow
events to OTLP) is part of the same milestone so Shadow can sit alongside existing observability.

## Surface

- `POST /api/v1/otlp/v1/traces` accepting OTLP/HTTP with the JSON encoding (implemented); the
  protobuf encoding answers `415` for now. The standard path suffix means an exporter can be
  pointed at Shadow with a base URL of `http://localhost:4000/api/v1/otlp`.
- Resource attributes `service.namespace` / `service.name` identify project and agent, with
  `SHADOW_OTLP_DEFAULT_PROJECT` as the project fallback (implemented).
- An `exporters` configuration to forward Shadow events to an OTLP endpoint (planned).

## Mapping

### Identity

| OpenTelemetry                                               | Shadow                                                                                    |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Resource `service.namespace` (fallback: configured default) | Project slug                                                                              |
| Resource `service.name`                                     | Agent slug                                                                                |
| OTel `trace_id`                                             | Shadow trace id (`trc_otel_<trace_id>`), one Shadow trace per OTel trace                  |
| Root span                                                   | `trace.started` / `trace.completed` or `trace.failed` (status `ERROR`) and the agent span |
| OTel `span_id`                                              | Shadow `spanId` (`spn_<span_id>`); `parent_span_id` -> `parentSpanId`                     |
| Span start / end time                                       | opener `timestamp` / closer `timestamp`, `durationMs` on the closer                       |
| Span attributes, events, links, status                      | `metadata.otel`                                                                           |

One OTel span becomes an opener/closer **pair** of Shadow events (spans are events in Shadow),
ordered by start time for openers and end time for closers, with `sequence` assigned in that
order.

### GenAI spans

| Span (semconv)                                                      | Shadow events                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gen_ai.operation.name = chat`/`text_completion`/`generate_content` | `model.request` (input: `provider` from `gen_ai.system`, `model` from `gen_ai.request.model`, `messages` from prompt events or `gen_ai.input.messages`, `parameters` from `gen_ai.request.*`) and `model.response` (output message from completion events or `gen_ai.output.messages`, `finishReason` from `gen_ai.response.finish_reasons`, `tokenUsage` from `gen_ai.usage.input_tokens` / `output_tokens`) |
| `gen_ai.operation.name = execute_tool`                              | `tool.request` (`name` = `gen_ai.tool.name`, arguments from `gen_ai.tool.call.arguments`) and `tool.response` (result from `gen_ai.tool.call.result`) or `tool.error` on status `ERROR` (`error.type` -> `code`)                                                                                                                                                                                              |
| `gen_ai.operation.name = invoke_agent` / `create_agent`             | Agent span: `agent.started` / `agent.completed` (nested agents become nested agent spans)                                                                                                                                                                                                                                                                                                                     |
| Model response tool calls                                           | `model.response.output.toolCalls` from `gen_ai.output.messages` tool-call parts                                                                                                                                                                                                                                                                                                                               |

Prompt and completion span events (`gen_ai.content.prompt`, `gen_ai.content.completion`) are
used when message attributes are absent. Content capture is opt-in in most OTel SDKs; without it
Shadow records model calls with empty messages and flags them (`metadata.otel.contentMissing`).

### Generic spans

Spans without GenAI attributes are mapped by name and kind:

- `SpanKind.CLIENT` spans with `http.*`, `db.*` or `rpc.*` attributes become
  `tool.request`/`tool.response` with `name` = span name and the attributes as arguments; this
  matches how most frameworks expose external calls.
- Other spans become `otel.span_started` / `otel.span_ended` events (custom types) so hierarchy
  is preserved without pretending they are tools.

### State and context

OpenTelemetry has no notion of agent state. The proposal reserves attributes so instrumented
code can opt in:

- span event `shadow.context.set` with attributes `key` and `value` (JSON) -> `context.added`;
- span event `shadow.state.patch` with `ops` (JSON) -> `state.patch`;
- span event `shadow.state.snapshot` with `state` and `context` (JSON) -> `state.snapshot`.

`shadow.context.set`, `shadow.context.remove` and `shadow.policy.evaluated` are implemented;
the `shadow.state.*` events are not yet. Without them, OTLP-imported traces have empty state and
context.

### Policies and approvals

No semantic convention exists. The span event `shadow.policy.evaluated` (attributes `policy`,
`decision`, `reason`, `subject`) maps to `policy.evaluated`; `shadow.approval.requested` /
`shadow.approval.resolved` are proposed and not implemented yet.

## Ordering and sequences

OTLP delivers spans out of order and in batches. Within one request the importer orders each
OTel trace's events by (start time for openers, end time for closers, span id for ties) and
stores them in one ingestion call; the root span's end closes the trace
(`trace.completed`, or `trace.failed` when its status is `ERROR`). Spans from later requests are
appended with fresh sequences and flagged `metadata.otel.late = true`; the lifecycle events are
not emitted twice. Buffering until the root span ends, so that a trace exported across several
batches gets one consistent ordering, is not implemented yet.

## Export (Shadow to OTLP)

The reverse mapping turns each opener/closer pair into one span with the GenAI attributes above,
puts `metadata` into span attributes (flattened, size-capped), and emits state and policy events
as span events. Replayed branches are exported as separate OTel traces linked to the original with
a span link, since OTLP has no branch concept.

## Limitations

- OTLP traces are not replayable: there is no program to re-run. They support historical
  inspection and comparison between separately recorded traces only.
- Attribute size limits in OTel SDKs truncate large prompts and tool results; the importer cannot
  recover truncated content.
- Semantic conventions for GenAI are still evolving; the importer will version its mapping and
  record the convention version it assumed in `metadata.otel.semconv` (currently `1.36.0`).
- Only the JSON encoding of OTLP/HTTP is accepted; protobuf and gRPC exporters need a collector
  in between, configured with the `otlphttp` exporter and `encoding: json`.

## Open questions

- Whether to accept OTLP/gRPC in addition to OTLP/HTTP.
- How to group multiple OTel traces into one Shadow trace for agents that start a new OTel trace
  per turn.
- Whether spans with `SpanKind.SERVER` should open agent spans automatically.
