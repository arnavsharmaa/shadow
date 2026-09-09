# Roadmap

This document describes where Shadow is going. It distinguishes between work that is
**committed** (scheduled and being built) and **ideas / under consideration** (plausible, but not
yet designed or scheduled). Dates are intentionally absent; releases ship when they are ready.

Shadow follows [Semantic Versioning](https://semver.org). Before 1.0, minor releases may change
package and HTTP APIs, but the stored trace schema only changes with a migration (see
[docs/concepts/schema-versioning.md](./docs/concepts/schema-versioning.md)). Feedback on any item
is welcome through GitHub issues; integration proposals have their own
[issue template](./.github/ISSUE_TEMPLATE/integration_request.yml).

## v0.1 — Foundations (released 2026-09-03)

### Committed / done

- Append-only, versioned event model (`schemaVersion` 1.0) with 25 known event types, open
  `category.action` type strings and preservation of unknown fields.
- Entities: project, agent, trace, branch, span, event, state snapshot, fork, replay, comparison,
  cost record (branch metrics); artifacts attached to traces, branches or events.
- State model: JSON state document with RFC 6902 `add`/`replace`/`remove` patches, key/value
  context, snapshots every N mutations, reconstruction at any event boundary, before/after diffs.
- Forks with typed overrides: context set/remove, state set/remove by JSON pointer, tool result
  substitution, tool error injection, policy configuration.
- Three replay modes in the engine: historical, deterministic counterfactual (history cursor,
  fork-point state verification, virtual clock, seeded ids) and the live re-execution
  architecture (disabled in the API for this release).
- Comparison engine: shared prefix, LCS alignment with a greedy fallback for large suffixes,
  first divergence, added/removed/modified events, tool-call diffs by occurrence, context and
  state diffs, metric deltas, outcome and policy decision changes.
- Fastify API with Zod validation and OpenAPI (`/docs`, `/openapi.json`); cursor pagination;
  export/import of self-contained `shadow.trace` bundles.
- Storage on PostgreSQL through Drizzle, with embedded PGlite as the zero-setup default.
- `@shadow/sdk` (batching, retrying HTTP transport, client-side redaction, never throws into agent
  code) and `@shadow/cli` (`shadow traces list|inspect|export|import`, `shadow fork`,
  `shadow replay`, `shadow compare`).
- Web app: trace explorer, trace detail with execution tree, event inspector, state/context
  inspector, timeline, fork editor, branch DAG and comparison view.
- Deterministic demo data (refund, inventory, FAQ, enrichment, access-request agents) and the
  canonical refund-agent counterfactual.
- Security baseline: input validation, bounded payloads, key/value-pattern redaction on both
  client and server, no dynamic code execution.

## v0.2 — Framework integrations

### Committed

- **OpenTelemetry / OTLP ingestion**: accept OTLP traces and map GenAI semantic-convention spans
  to Shadow events ([proposal](./docs/integrations/opentelemetry.md)).
- **OpenAI Agents SDK adapter**: record runs, handoffs, tool calls and guardrails
  ([proposal](./docs/integrations/openai-agents-sdk.md)).
- **LangGraph adapter**: map graph nodes, edges and checkpoints to spans, events and state
  snapshots ([proposal](./docs/integrations/langgraph.md)).
- **MCP tracing**: record Model Context Protocol tool and resource calls between hosts and servers
  ([proposal](./docs/integrations/mcp.md)).
- **Anthropic tool-use traces**: import Messages API tool-use loops as model and tool spans
  ([proposal](./docs/integrations/anthropic.md)).
- **Exporters**: push traces to external destinations (OTLP, files) in addition to the existing
  bundle export.
- A published integration guide for custom runtimes with conformance tests for adapters.

### Ideas / under consideration

- Adapters for additional frameworks (Vercel AI SDK, LlamaIndex, CrewAI, AutoGen), prioritised by
  community demand.
- A Python SDK implementing the same `AgentHost` contract.
- Streaming ingestion (server-sent events or WebSocket) for very long-running agents.

## v0.3 — Team workflows

### Committed

- Authentication and per-project authorisation (API keys and single sign-on), the prerequisite
  for any shared deployment.
- Sharing: permalinks to events, branches and comparisons; read-only trace sharing.
- Annotations and comments on events and branches.
- Saved views and filters in the explorer; trace tagging from the UI.
- Retention policies and bulk deletion.

### Ideas / under consideration

- Notifications (webhooks, chat integrations) on policy violations or failed replays.
- Trace collections for grouping related executions (batches, experiments, incidents).
- Audit log of who forked, replayed or deleted what.

## v0.4 — Advanced replay

### Committed

- **Live re-execution**: enable the `live` replay mode against real models and tools, with
  explicit nondeterminism warnings and cost guards.
- **Model substitution**: replay a branch with a different provider or model.
- **Prompt overrides**: edit system or user messages at the fork point.
- **Tool mocks**: declarative mock definitions for tools that are not registered as programs.
- **Scenario matrices**: fork one event with a grid of overrides and compare every branch.
- **Batch counterfactuals**: apply the same override set across many traces of an agent.

### Ideas / under consideration

- Replay of SDK-recorded traces without a registered program, by treating the recorded model
  responses as a scripted model and re-running only the tools that changed.
- Property-based fuzzing of tool results and policy configurations.
- Cost and latency budgets that abort a replay when exceeded.

## v0.5 — Production observability

### Committed

- Scalable storage path: table partitioning by time and project, hot/cold tiers, object-storage
  offload for large payloads (see [ADR 0004](./docs/adr/0004-postgres-initial-storage.md)).
- Metrics and dashboards: per-agent cost, latency, error and policy-violation trends.
- Alerting on anomalies in cost, tool failures and policy decisions.
- Sampling and rate limiting on ingestion.
- Real pricing tables and per-provider cost providers; the bundled `shadow-sim` pricing remains
  for demos.

### Ideas / under consideration

- Columnar analytics store (ClickHouse or similar) for cross-trace queries.
- Encryption at rest and field-level encryption for sensitive payloads.
- Multi-region deployment guides.

## v1.0 — Stable platform

### Committed

- Stable `@shadow/schemas`, `@shadow/sdk` and HTTP API surfaces with a documented deprecation
  policy.
- Trace schema 1.x compatibility guarantee and a tested migration path for every prior version.
- Multi-tenant deployment with authentication, authorisation, encryption and audit logging.
- Long-term support policy for the 1.x line.

### Ideas / under consideration

- Plugin system for custom event types, inspectors and comparison heuristics.
- Hosted offering built on the same open-source core.

## How to influence the roadmap

Open an issue describing the problem you are trying to solve rather than the feature you want;
that makes it easier to find the design that fits the event model. Upvote existing issues to
signal demand, and see [CONTRIBUTING.md](./CONTRIBUTING.md) if you would like to build something
yourself.
