# Shadow documentation

Shadow is an open-source time-travel debugger for AI agents: record every step an agent takes,
reconstruct what it knew at any point, fork the execution with changed inputs, replay it
deterministically and compare the branches.

Start with the [project README](../README.md) for installation and the demo, then use this index.

## Concepts

| Document                                                 | What it covers                                                                                                                |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| [Events](./concepts/events.md)                           | The event schema, all 25 known event types with payloads, spans and hierarchy, the `metadata.shadow` namespace                |
| [State and context](./concepts/state-and-context.md)     | The JSON state document and key/value context, mutation events, snapshots, reconstruction, diffs                              |
| [Forks and overrides](./concepts/forks-and-overrides.md) | Branch lineage, fork points, the five override kinds, the refund-agent worked example                                         |
| [Replay modes](./concepts/replay-modes.md)               | Historical, deterministic counterfactual and live replay; determinism guarantees and limits; registering a replayable program |
| [Branch comparison](./concepts/branch-comparison.md)     | Shared prefix, alignment, first divergence, tool/context/state diffs, metric deltas                                           |
| [Schema versioning](./concepts/schema-versioning.md)     | `MAJOR.MINOR` compatibility policy and migration strategy                                                                     |
| [Cost tracking](./concepts/cost-tracking.md)             | Token usage, estimated costs, pricing providers, branch metrics                                                               |

## Architecture

| Document                               | What it covers                                                                                  |
| -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [Overview](./architecture/overview.md) | Packages, data flow (agent → SDK → API → store → replay → comparison → web), package boundaries |
| [Storage](./architecture/storage.md)   | Tables, indexes, effective lineage queries, snapshot strategy, export/import, scaling path      |
| [API](./architecture/api.md)           | Route reference with request/response shapes, pagination, errors, configuration                 |

## Integrations

| Document                                                 | Status                                                                           |
| -------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [Integrations overview](./integrations/README.md)        | Mapping principles, the `AgentHost` contract, how adapters plug in               |
| [Custom runtime](./integrations/custom-runtime.md)       | Available now: SDK instrumentation and bundle import with a worked event mapping |
| [OpenTelemetry / OTLP](./integrations/opentelemetry.md)  | Proposal for v0.2                                                                |
| [OpenAI Agents SDK](./integrations/openai-agents-sdk.md) | Proposal for v0.2                                                                |
| [LangGraph](./integrations/langgraph.md)                 | Proposal for v0.2                                                                |
| [Model Context Protocol](./integrations/mcp.md)          | Proposal for v0.2                                                                |
| [Anthropic tool-use traces](./integrations/anthropic.md) | Proposal for v0.2                                                                |

## Decisions

| Document                                               | Decision                                 |
| ------------------------------------------------------ | ---------------------------------------- |
| [ADR index and template](./adr/README.md)              | How and when to write an ADR             |
| [ADR 0001](./adr/0001-event-sourced-trace-model.md)    | Event-sourced trace model                |
| [ADR 0002](./adr/0002-typescript-monorepo.md)          | TypeScript monorepo                      |
| [ADR 0003](./adr/0003-deterministic-vs-live-replay.md) | Deterministic versus live replay         |
| [ADR 0004](./adr/0004-postgres-initial-storage.md)     | PostgreSQL and PGlite as initial storage |

## Project

| Document                                                     | What it covers                                                                                              |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| [Contributing](../CONTRIBUTING.md)                           | Setup, workflow, testing, commits, pull requests, adding event types and integrations, migrations, releases |
| [Security policy](../SECURITY.md)                            | Supported versions, private vulnerability reporting, threat model, redaction limits                         |
| [Code of conduct](../CODE_OF_CONDUCT.md)                     | Contributor Covenant v2.1                                                                                   |
| [Roadmap](../ROADMAP.md)                                     | v0.1 to v1.0 milestones, committed versus under consideration                                               |
| [Changelog](../CHANGELOG.md)                                 | Release history                                                                                             |
| [GitHub labels](./github-labels.md)                          | Label taxonomy and the `scripts/create-labels.sh` script                                                    |
| [Issue templates](../.github/ISSUE_TEMPLATE)                 | Bug report, feature request, integration request                                                            |
| [Pull request template](../.github/PULL_REQUEST_TEMPLATE.md) |                                                                                                             |

## Quick reference

- Run everything locally: `pnpm install && pnpm dev` (API on `http://localhost:4000`, web on
  `http://localhost:3000`, OpenAPI at `http://localhost:4000/docs`).
- Canonical demo: `pnpm demo` records the refund agent, forks it before `refund_order` with
  `refundLimit = 100`, replays the fork and compares the branches.
- CLI: `shadow traces list`, `shadow traces inspect <traceId>`, `shadow traces update <traceId>`, `shadow traces prune --before <cutoff>`, `shadow traces delete <traceId>`,
  `shadow traces export <traceId>`,
  `shadow traces import <file>`, `shadow fork <traceId> --at <eventId> --set key=value`,
  `shadow replay <branchId>`, `shadow compare <baseBranchId> <targetBranchId>`,
  `shadow events show <traceId> <eventId>`, `shadow artifacts list <traceId>`,
  `shadow artifacts get <traceId> <artifactId>`.
- Database: embedded PGlite by default (`.shadow/data`); set `DATABASE_URL` for PostgreSQL;
  `pnpm db:migrate`, `pnpm db:seed`, `pnpm db:reset`.
