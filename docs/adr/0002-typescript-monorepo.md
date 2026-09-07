# 0002. TypeScript monorepo

- **Status:** Accepted
- **Date:** 2026-09-03
- **Deciders:** Shadow maintainers

## Context

Shadow consists of several deliverables that must agree on one contract: an instrumentation SDK
that runs inside agent processes, an engine that reconstructs state and replays programs, an HTTP
API, a CLI and a web application. The event schema is the coupling point for all of them, and
the same agent program has to run unchanged under the SDK (live recording) and under the engine
(deterministic replay).

The first users are TypeScript/JavaScript agent developers. Web UI, API and SDK all target the
same runtime, and the replay engine benefits from running in the same process as the API.

## Decision

We will develop Shadow as a **single pnpm workspace written in TypeScript**, built with
Turborepo, and publish the reusable packages to npm under the `@shadow` scope.

- `packages/schemas` holds Zod schemas and inferred types. It is the only place a wire format or
  entity shape is defined; every other package imports from it. It also defines the `AgentHost`
  contract as plain interfaces with no runtime code.
- `packages/core` implements the engine (event log, state, forks, replay, comparison, redaction,
  pricing) with no I/O and no framework dependencies, so it can run in the API, in tests, in the
  CLI and, later, in the browser.
- `packages/sdk` depends only on `packages/schemas`; it must stay small and dependency-free
  because it ships inside user processes.
- `packages/cli`, `apps/api` and `apps/web` are consumers. `apps/*` are private; `packages/*`
  are publishable.
- `packages/testkit` provides deterministic scenarios and adapters shared by tests, seeds, the
  demo and examples.
- `packages/config` centralises TypeScript, ESLint and Prettier configuration so every package
  is checked the same way.
- Workspace packages reference each other with `workspace:*` and export TypeScript sources in
  development (`exports` pointing at `src`) and built artifacts on publish (`publishConfig`).
- Node `>= 22.12` (24 LTS primary), pnpm 10 via corepack, exact dependency pins.

## Consequences

Positive:

- One schema, one type system, one test runner and one lint configuration across SDK, engine,
  API and UI; a schema change fails type-checking in every consumer immediately.
- The same `AgentDefinition` runs in the seed (recording), in replay and in unit tests, which is
  what makes the deterministic demo possible.
- Atomic changes: a feature that touches schema, engine, API and UI ships in one pull request
  with one CI run.
- Turborepo caches builds, lint and tests per package, keeping `pnpm check` fast.

Negative:

- Non-TypeScript agent ecosystems (notably Python) cannot use `@shadow/sdk` directly; they need
  a separate SDK that implements the same contract or must import bundles. This is a roadmap item.
- Coordinated versioning: packages are released together, so a change in one bumps all.
- The dependency direction (`schemas <- core <- sdk/cli/api`) must be policed; an accidental
  import of `@shadow/core` from the SDK would drag the engine into user processes.

Neutral:

- The web app and CLI are written concurrently with the engine; the monorepo makes that
  workable but requires discipline about which package owns what.

## Alternatives considered

- **Polyglot: Go or Rust service with a TypeScript SDK.** Better raw performance for ingestion
  and alignment, but the engine and the SDK would implement the `AgentHost` contract twice, the
  replay engine would have to host user programs across a process boundary, and schema changes
  would need code generation in two languages. Rejected for v0.x; can be revisited for a
  high-throughput ingestion tier.
- **Multiple repositories.** Independent release cadences, but every schema change becomes a
  multi-repository coordination problem, and the deterministic demo (seed, replay, comparison)
  spans all of them. Rejected.
- **Python first.** Many agent frameworks are Python-centric, but the web UI, API and engine
  would still be TypeScript, splitting the contract across languages from day one. Rejected in
  favour of a later Python SDK against a stable schema.
- **npm or Yarn workspaces instead of pnpm.** pnpm's strict node_modules layout catches undeclared
  dependencies (important for the SDK's footprint) and `workspace:*` protocol semantics are
  well suited to publishing. Rejected.
