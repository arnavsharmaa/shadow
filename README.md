# Shadow

**Time-travel debugging for AI agents.**

Rewind an agent to any decision, change its state or tool result, replay the execution, and compare what happens next.

[![CI](https://github.com/arnavsharmaa/shadow/actions/workflows/ci.yml/badge.svg)](https://github.com/arnavsharmaa/shadow/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.0-informational.svg)](CHANGELOG.md)
[![Node](https://img.shields.io/badge/node-%3E%3D22.12-brightgreen.svg)](.nvmrc)

> Shadow is Chrome DevTools + git branching for AI-agent executions.

![Trace detail: execution tree, event inspector, state inspector and timeline](docs/assets/trace-detail.png)

<details>
<summary>More screenshots</summary>

![Trace explorer](docs/assets/trace-explorer.png)

![Branch comparison](docs/assets/comparison.png)

</details>

---

## Why Shadow?

Agents fail in ways that are hard to reproduce: a stale document in context, a tool that timed out, a policy that evaluated against the wrong number. Logs tell you _what_ happened; they rarely let you ask _what would have happened otherwise_.

Shadow records every model call, tool call, policy evaluation and state change as an append-only event log, so you can answer:

- What did my agent know at this point?
- Why did it call this tool, and what changed after the call?
- Where did the eventual failure originate?
- What if this tool had returned something else?
- What if the agent had a different policy, or one piece of context were removed?
- Which branch was cheaper or faster, and which event caused the two executions to diverge?

## Features

- **Structured traces.** Versioned, vendor-neutral event schema (`model.*`, `tool.*`, `policy.*`, `state.*`, `context.*`, `human.*`, …) with spans, token usage and estimated cost.
- **State reconstruction.** Full snapshots plus incremental patches; rebuild state and context at any event boundary and diff between events or branches.
- **Forks with typed overrides.** Context, state, tool-result, tool-error injection and policy overrides. Every fork is a real child branch with lineage metadata.
- **Deterministic counterfactual replay.** The recorded prefix is replayed from history; the fork continues against deterministic adapters. Same inputs, byte-identical output.
- **Branch comparison.** First divergence, added/removed/modified events, tool argument and result diffs, context/state diffs, token/cost/latency deltas, outcome and policy deltas.
- **Debugging UI.** Trace explorer with filters and search, trace detail with execution tree, event inspector, state inspector and timeline, fork editor, branch graph and comparison view.
- **SDK, CLI and HTTP API.** Instrument any TypeScript agent, import/export traces as JSON, drive everything from the terminal.
- **Zero-infrastructure local mode.** PostgreSQL schema on an embedded database for `pnpm dev`; real PostgreSQL via `DATABASE_URL` or `docker compose up`.

## Demo

The bundled scenario is a customer-support refund agent. It reads an outdated policy document (autonomous limit **$500**) while the company's real limit is **$100**, refunds **$480**, and fails its compliance audit.

```text
Original                                Counterfactual (refundLimit = 100)
────────────────────────────────────    ────────────────────────────────────
customer request                        customer request
→ read_customer                         → read_customer
→ search_orders                         → search_orders
→ inspect_order                         → inspect_order
→ read_policy   (limit: 500, stale)     → read_policy   (limit: 500, stale)
→ refund_order($480) → ALLOWED          → refund_order($480) → APPROVAL REQUIRED
→ send_email                            → human approval requested (pending)
→ compliance audit → POLICY VIOLATION   → send_email ("under review")
                                        → compliance audit → POLICY SATISFIED
```

Rewind to just before `refund_order`, fork with `refundLimit = 100`, replay, and Shadow shows the first divergence (`policy.evaluated refund.autonomous_limit`: `allow` → `approval_required`), the outcome change, and the cost and latency deltas. No API keys are needed: the demo agents use deterministic simulated models and tools.

## Quick start

Requirements: Node.js ≥ 22.12 (24 LTS recommended) and pnpm 10 (`corepack enable`).

```bash
git clone https://github.com/arnavsharmaa/shadow.git
cd shadow
pnpm install
pnpm demo
```

`pnpm demo` applies migrations to an embedded database, seeds the deterministic demo traces, and starts the API (http://localhost:4000, OpenAPI at `/docs`) and the web app (http://localhost:3000).

60-second tour:

1. Open http://localhost:3000 and click **refund-request: defective headphones**.
2. Select the `refund_order` tool request. The state inspector shows `refundLimit = 500`.
3. Click **Fork from here**, click the `refundLimit` chip, change the value to `100`, and press **Run counterfactual**.
4. The comparison view opens: outcome `Policy violation` → `Approval requested`, first divergence at the policy evaluation, lower estimated cost and latency.

With Docker:

```bash
docker compose up
```

## Architecture

```mermaid
flowchart LR
  subgraph Instrumentation
    A[Agent] --> S["@shadow/sdk<br/>Trace = AgentHost"]
  end
  subgraph "apps/api (Fastify)"
    S -->|HTTP JSON events| I[Ingestion API]
    I --> E[(Event store<br/>PostgreSQL / PGlite)]
    E --> R[Replay orchestration]
    E --> C[Comparison service]
  end
  subgraph "packages/core (engine)"
    R --> RE[Replay engine<br/>history cursor + adapters]
    C --> CE[Comparison engine]
    E --> ST[State reconstruction]
  end
  subgraph "apps/web (Next.js)"
    W[Trace explorer · Trace detail · Fork editor · Branch graph · Comparison]
  end
  I --> W
  RE --> E
  CE --> W
  ST --> W
  CLI["@shadow/cli"] --> I
```

| Package           | Responsibility                                                                                                    |
| ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| `@shadow/schemas` | Zod schemas and types: events, entities, overrides, comparison model, API contracts, `AgentHost`                  |
| `@shadow/core`    | Event ordering, state reconstruction, fork semantics, deterministic replay, branch comparison, redaction, pricing |
| `@shadow/testkit` | Deterministic scenario agents, mock adapters and demo data                                                        |
| `@shadow/sdk`     | Instrumentation SDK with batching HTTP transport                                                                  |
| `@shadow/cli`     | `shadow` command line                                                                                             |
| `@shadow/api`     | Fastify service: persistence (Drizzle), migrations, ingestion, replay registry, OpenAPI                           |
| `@shadow/web`     | Next.js application                                                                                               |

See [docs/architecture](docs/architecture/overview.md) and the [ADRs](docs/adr/README.md).

## Core concepts

- **Trace** – one execution. Its initial execution is the root branch `main`.
- **Branch** – one execution lineage. A fork creates a child branch that inherits the parent's events up to the fork point and stores only what happens afterwards.
- **Event** – an append-only record (`tool.request`, `model.response`, `policy.evaluated`, `state.patch`, …) with sequence, span, timestamps, payloads, tags, token usage and estimated cost. Unknown event types and fields are preserved.
- **State and context** – state is the agent's working document (JSON-pointer patches); context is the key/value knowledge the agent has at each moment. Both are reconstructed at any event.
- **Fork** – the persisted definition of a counterfactual: parent branch, fork event, and typed overrides.
- **Replay** – execution of a fork. See [Replay modes](#replay-modes).
- **Comparison** – structured diff of two branches shared by the API and the UI.

Details: [docs/concepts](docs/concepts/events.md).

## SDK

```ts
import { Shadow } from "@shadow/sdk";

const shadow = new Shadow({ project: "support-agent", agent: "refund-agent" });
const trace = shadow.startTrace({ name: "refund-request", metadata: { customerId: "cus_1001" } });

trace.context.set("refundLimit", 500);

const orders = await trace.tool({
  name: "search_orders",
  arguments: { customerId: "cus_1001" },
  execute: (args) => searchOrders(args),
});

const decision = await trace.model({
  provider: "openai",
  model: "gpt-4.1",
  messages: [{ role: "user", content: "Is this order refundable?" }],
  execute: async (req) => callModel(req), // returns { message, tokenUsage, estimatedCost? }
});

await trace.tool({
  name: "refund_order",
  arguments: { orderId: "ord_5001", amount: 480 },
  guard: { policy: "refund.autonomous_limit", subject: { amount: 480 }, evaluate: checkLimit },
  execute: (args) => refundOrder(args),
});

trace.snapshot();
await trace.end({ outcome: { kind: "refunded", label: "Refund issued" } });
```

Events are buffered, redacted (passwords, API keys, tokens, cookies, …) and sent in batches. Transport failures never throw into agent code. See [packages/sdk](packages/sdk/README.md) and [examples/](examples/).

## CLI

```bash
shadow --version
shadow --help
shadow status
shadow traces list --project support-agent --status failed
shadow traces inspect trc_demo_refund_violation
shadow traces inspect trc_demo_refund_violation --grep refund_order
shadow events show trc_demo_refund_violation <eventId>
shadow traces update trc_demo_refund_violation --tag triaged --meta owner=jordan
shadow artifacts list trc_demo_refund_violation
shadow traces prune --before 90d --status completed --dry-run
shadow traces delete <traceId> --yes
shadow traces export trc_demo_refund_violation --out refund.json
shadow traces import refund.json --regenerate-ids
shadow fork trc_demo_refund_violation --at <eventId> --set refundLimit=100 --replay
shadow replay <branchId>
shadow compare <baseBranchId> <targetBranchId>
```

In this repository run it with `pnpm --filter @shadow/cli exec tsx src/cli.ts …` or build it (`pnpm build`) and use `packages/cli/bin/shadow.js`. Set `--endpoint` or `SHADOW_ENDPOINT` for a non-default API.

## API

Versioned REST API with OpenAPI documentation at `/docs` (`/openapi.json`).

```text
GET  /health
GET  /api/v1/projects                     POST /api/v1/projects
GET  /api/v1/traces                       POST /api/v1/traces
GET  /api/v1/traces/:traceId              DELETE /api/v1/traces/:traceId
GET  /api/v1/traces/:traceId/events       POST /api/v1/traces/:traceId/events
GET  /api/v1/traces/:traceId/events/:eventId/state
GET  /api/v1/traces/:traceId/tree
GET  /api/v1/traces/:traceId/branches
GET  /api/v1/traces/:traceId/forks        POST /api/v1/traces/:traceId/forks
GET  /api/v1/traces/:traceId/export       POST /api/v1/traces/import
GET  /api/v1/branches/:branchId           PATCH/DELETE /api/v1/branches/:branchId
GET  /api/v1/branches/:branchId/state     POST /api/v1/branches/:branchId/replay
GET  /api/v1/comparisons                  POST /api/v1/comparisons
GET  /api/v1/comparisons/:comparisonId
```

Events are cursor-paginated; every error is `{ "error": { "code", "message", "details?", "requestId" } }`. Reference: [docs/architecture/api.md](docs/architecture/api.md).

## Replay modes

Shadow does not claim that arbitrary LLM executions can be reproduced. It distinguishes three modes:

| Mode                             | What runs                                                                                                               | Deterministic?                  | Status in v0.1                                                             |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------- |
| **Historical replay**            | Nothing. Recorded events, snapshots, model outputs and tool results are rendered.                                       | Yes, by construction            | Available for every trace                                                  |
| **Deterministic counterfactual** | The agent program re-executes. Recorded prefix served from history; after the fork, deterministic adapters + overrides. | Yes (seeded ids, virtual clock) | Available for agents registered in the replay registry (bundled scenarios) |
| **Live re-execution**            | The agent program re-executes against real models/tools via its `execute` callbacks.                                    | **No**                          | Architecture present; API returns `501` in v0.1                            |

Deterministic replay verifies that the program reproduces the recorded prefix; any mismatch aborts with a precise `ReplayHistoryMismatchError` instead of producing a misleading branch. Read [docs/concepts/replay-modes.md](docs/concepts/replay-modes.md) and [ADR 0003](docs/adr/0003-deterministic-vs-live-replay.md).

## Examples

- [`examples/refund-agent`](examples/refund-agent) – the refund agent recorded through the SDK against a running Shadow.
- [`examples/simple-tool-agent`](examples/simple-tool-agent) – an inventory agent whose tool times out three times and takes the wrong action; fork with a tool-result override to see the correct action.

```bash
pnpm dev                                          # in one terminal
pnpm --filter @shadow/example-refund-agent start  # in another
```

## Development

```bash
pnpm install
pnpm dev            # API + web with hot reload (embedded database in .shadow/data)
pnpm db:migrate     # apply migrations
pnpm db:seed        # seed demo data
pnpm db:reset       # drop, migrate, seed
pnpm db:generate    # generate a migration after editing apps/api/src/db/schema.ts
pnpm lint && pnpm format:check && pnpm typecheck
pnpm build
```

Set `DATABASE_URL=postgres://shadow:shadow@localhost:5432/shadow` to use PostgreSQL. All configuration is documented in [.env.example](.env.example). Guidance for contributors and coding agents lives in [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md).

## Testing

```bash
pnpm test              # unit tests (schemas, core engine, SDK, CLI, API units)
pnpm test:coverage     # with coverage; core enforces 85% lines / 85% functions / 75% branches
pnpm test:integration  # API against an embedded database (or DATABASE_URL)
pnpm test:e2e          # Playwright: the canonical rewind → fork → replay → compare workflow
pnpm bench             # ~10,000-event trace: ingestion, reconstruction, replay, comparison timings
```

CI runs lint, formatting, typecheck, unit and integration tests (embedded and PostgreSQL service container), production builds and the E2E suite on every pull request and push to `main`.

## Roadmap

v0.1 (this release) delivers local time travel: schema, ingestion, explorer, state reconstruction, deterministic replay, forks, comparison, SDK, CLI, examples, Docker and CI. Next: framework integrations (OpenTelemetry, OpenAI Agents SDK, LangGraph, MCP), team workflows, live re-execution and production observability. See [ROADMAP.md](ROADMAP.md).

## Security

Trace data can contain sensitive customer and business data. Shadow validates and bounds all input, redacts common secret fields on both the SDK and the server (configurable with `SHADOW_REDACT_PATTERNS`), never executes uploaded content, and logs with redaction. Authentication is a single optional bearer token (`SHADOW_API_TOKEN`, forwarded by the SDK, CLI and web app); there is no per-user authorisation, so run Shadow locally or on a trusted network. Production multi-tenant authentication and encryption controls are roadmap items. Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Contributing

Bug reports, feature requests and integration proposals are welcome; issue templates are provided. Read [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow, commit convention and release process, and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

Apache License 2.0. See [LICENSE](LICENSE).
