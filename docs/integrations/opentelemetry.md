# OpenTelemetry (OTLP) integration

> **Status: OTLP/HTTP ingestion and the reverse exporter are implemented**
> (`POST /api/v1/otlp/v1/traces` and `GET /api/v1/traces/:traceId/export?format=otlp`, JSON and
> protobuf encodings); the mapping below is what the importer and exporter do today. Not yet
> implemented: OTLP/gRPC. Traces imported this way can be inspected, searched, exported and
> compared, but not forked and replayed (there is no program to re-run).

## Using it

Point an OTLP/HTTP exporter at the API (protobuf, the exporters' default, or JSON), for example
with the OpenTelemetry JavaScript SDK:

```ts
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

const exporter = new OTLPTraceExporter({
  url: "http://localhost:4000/api/v1/otlp/v1/traces",
  headers: { authorization: "Bearer <SHADOW_API_TOKEN>" }, // only when the API requires a token
});
```

Environment-based configuration works too: `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:4000/api/v1/otlp/v1/traces`
with `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf` (or `http/json`). The OpenTelemetry Collector's
`otlphttp` exporter works with its defaults. Each request returns the OTLP success envelope
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

Files exported by a collector's `file` exporter (one JSON request per line) or saved by hand can
be sent with `shadow otlp import <file...>`.

Resource attribute `service.namespace` selects the project (default
`SHADOW_OTLP_DEFAULT_PROJECT`, `otel`) and `service.name` the agent. Imported traces are tagged
`otel`, every event has `source: "otlp"` and `metadata.otel` keeps the span id, kind, scope,
attributes (token usage moved to `metadata.otel.usage` and the event's `tokenUsage`) and status.
Event ids are `evt_otel_<traceId>_<spanId>_start|_end`, since span ids are unique only within a
trace. Spans re-sent by a retrying exporter are ignored by id; spans that arrive
after the root span was stored are appended and flagged `metadata.otel.late`.

## Goal

Accept OpenTelemetry traces, in particular spans that follow the
[GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/), and turn them
into Shadow traces so that agents already instrumented with OpenTelemetry (directly or through a
framework) can be inspected and compared without changing code. A reverse exporter (Shadow
events to OTLP) is part of the same milestone so Shadow can sit alongside existing observability.

## Surface

- `POST /api/v1/otlp/v1/traces` accepting OTLP/HTTP in the protobuf and JSON encodings
  (implemented; the protobuf schema is the vendored opentelemetry-proto v1.5.0 descriptor). The
  standard path suffix means an exporter can be pointed at Shadow with a base URL of
  `http://localhost:4000/api/v1/otlp`.
- Resource attributes `service.namespace` / `service.name` identify project and agent, with
  `SHADOW_OTLP_DEFAULT_PROJECT` as the project fallback (implemented).
- `GET /api/v1/traces/:traceId/export?format=otlp` returning the trace as an OTLP
  `ExportTraceServiceRequest` (JSON, or protobuf with `encoding=protobuf` or
  `Accept: application/x-protobuf`), and `shadow otlp export <traceId> [--collector <url>]` to
  save it or push it to any OTLP/HTTP endpoint (implemented). A server-side push on trace
  completion is planned.

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
- span event `shadow.state.set` with `path` (JSON pointer) and `value` -> `state.patch`;
- span event `shadow.state.patch` with `ops` (JSON, RFC 6902 `add`/`replace`/`remove`) ->
  `state.patch`;
- span event `shadow.state.snapshot` with `state` and `context` (JSON) -> `state.snapshot`.

All of these are implemented, plus `shadow.state.set` with `path` and `value` (a single `add`
operation) as a convenience. Values arrive as JSON strings and are parsed; malformed patches
(unknown operations, invalid pointers) are dropped rather than failing the export. Without these
events, OTLP-imported traces have empty state and context.

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

`GET /api/v1/traces/:traceId/export?format=otlp` (and `shadow otlp export`) turns a trace into
one OTLP request:

- Every branch becomes its own OpenTelemetry trace (OTLP has no branch concept). Trace and span
  ids are derived from the Shadow ids with SHA-256, so repeated exports produce the same ids.
  A forked branch's root span links to the parent branch's root with `shadow.link = forked_from`,
  `shadow.fork.event_id`, `shadow.fork.sequence` and the fork's overrides as JSON.
- Each branch gets a synthetic root span (`invoke_agent <agent>`) carrying `shadow.trace.id`,
  `shadow.branch.*` (name, status, depth, outcome, cost) and the branch metadata; the resource
  carries `service.namespace` / `service.name` (project and agent slugs) plus the trace id,
  name, status and tags.
- Every Shadow span (opener + closer) becomes one span: `model.request/response` → `chat <model>`
  with `gen_ai.operation.name = chat`, provider, model, `gen_ai.input.messages`,
  `gen_ai.output.messages`, `gen_ai.request.<parameter>`, token usage and
  `gen_ai.response.finish_reasons`; `tool.request/response|error` → `execute_tool <tool>` with
  `gen_ai.tool.name`, `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result` and, for
  failures, `error.type` and an `ERROR` status; `agent.started/completed` → `invoke_agent`.
  Every span and span event also carries `shadow.event.id`, `shadow.event.type`,
  `shadow.event.name`, `shadow.event.sequence`, `shadow.event.severity`, `shadow.event.source`
  and flattened `shadow.metadata.<key>` attributes (strings capped at 32 KiB).
- Events inside a span that are neither its opener nor its closer become span events. Context,
  state and policy events use the reserved names above (`shadow.context.set`,
  `shadow.state.patch`, `shadow.state.snapshot`, `shadow.policy.evaluated`), so the importer
  maps them back; other events keep their Shadow type as the span-event name with their
  payloads as JSON attributes. Events outside any span (lifecycle, forks, replays) attach to the
  branch root span.
- Timestamps are millisecond precise in Shadow, so the event sequence is carried in the
  nanosecond digits of each span's start and end; sorting by time reproduces the recorded order.

Exporting and re-importing a trace reproduces its model and tool spans, names, context, state
and policy decisions (the round trip is covered by an integration test); step names survive
because the importer prefers `shadow.event.name` over the span name when it is present.
Replay-only detail (fork overrides, comparisons, artifacts) is not part of the OTLP model beyond
the link attributes.

## Limitations

- OTLP traces are not replayable: there is no program to re-run. They support historical
  inspection and comparison between separately recorded traces only.
- Attribute size limits in OTel SDKs truncate large prompts and tool results; the importer cannot
  recover truncated content.
- Semantic conventions for GenAI are still evolving; the importer will version its mapping and
  record the convention version it assumed in `metadata.otel.semconv` (currently `1.36.0`).
- OTLP/gRPC is not accepted; gRPC exporters need a collector in between with the `otlphttp`
  exporter. The reverse exporter speaks OTLP/HTTP only as well.

## Open questions

- Whether to accept OTLP/gRPC in addition to OTLP/HTTP.
- How to group multiple OTel traces into one Shadow trace for agents that start a new OTel trace
  per turn.
- Whether spans with `SpanKind.SERVER` should open agent spans automatically.
