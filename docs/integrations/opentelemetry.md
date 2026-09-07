# OpenTelemetry (OTLP) integration

> **Status: design proposal for v0.2. Not implemented in v0.1.** The mapping below is intended
> for review; details may change before code lands. Today, OpenTelemetry users can export spans
> themselves and convert them to a `shadow.trace` bundle following
> [custom-runtime.md](./custom-runtime.md).

## Goal

Accept OpenTelemetry traces, in particular spans that follow the
[GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/), and turn them
into Shadow traces so that agents already instrumented with OpenTelemetry (directly or through a
framework) can be inspected and compared without changing code. A reverse exporter (Shadow
events to OTLP) is part of the same milestone so Shadow can sit alongside existing observability.

## Proposed surface

- `POST /api/v1/otlp/v1/traces` accepting OTLP/HTTP (protobuf and JSON encodings), the standard
  path suffix so an OTLP exporter can be pointed at Shadow with a base URL of
  `http://localhost:4000/api/v1/otlp`.
- Mapping configuration on the API: which resource attributes identify project and agent, and
  which span attribute (if any) carries a Shadow trace id override.
- An `exporters` configuration to forward Shadow events to an OTLP endpoint.

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

Without these, OTLP-imported traces have empty state and context; forks are possible but only
tool and policy overrides are meaningful.

### Policies and approvals

No semantic convention exists. Proposed span events `shadow.policy.evaluated` (attributes
`policy`, `decision`, `reason`, `subject`) and `shadow.approval.requested` /
`shadow.approval.resolved` map to the corresponding Shadow events.

## Ordering and sequences

OTLP delivers spans out of order and in batches. The importer buffers spans per OTel trace until
the root span ends (or a configurable idle timeout), then emits a complete Shadow trace in one
ingestion call, assigning `sequence` by (start time for openers, end time for closers, span id
for ties). Late spans after finalisation are appended with fresh sequences and flagged
`metadata.otel.late = true`.

## Export (Shadow to OTLP)

The reverse mapping turns each opener/closer pair into one span with the GenAI attributes above,
puts `metadata` into span attributes (flattened, size-capped), and emits state and policy events
as span events. Replayed branches are exported as separate OTel traces linked to the original with
a span link, since OTLP has no branch concept.

## Limitations of the proposal

- OTLP traces are not replayable: there is no program to re-run. They support historical
  inspection and comparison between separately recorded traces only.
- Attribute size limits in OTel SDKs truncate large prompts and tool results; the importer cannot
  recover truncated content.
- Semantic conventions for GenAI are still evolving; the importer will version its mapping and
  record the convention version it assumed in `metadata.otel.semconv`.

## Open questions

- Whether to accept OTLP/gRPC in addition to OTLP/HTTP.
- How to group multiple OTel traces into one Shadow trace for agents that start a new OTel trace
  per turn.
- Whether spans with `SpanKind.SERVER` should open agent spans automatically.
