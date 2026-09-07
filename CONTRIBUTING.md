# Contributing to Shadow

Thank you for your interest in Shadow, a time-travel debugger for AI agents. This guide covers
everything you need to set up a development environment, make a change and get it merged.

By participating you agree to follow the [Code of Conduct](./CODE_OF_CONDUCT.md). Security
issues must be reported privately as described in [SECURITY.md](./SECURITY.md).

## Table of contents

- [Prerequisites](#prerequisites)
- [Install](#install)
- [Repository layout](#repository-layout)
- [Development workflow](#development-workflow)
- [Branches](#branches)
- [Testing](#testing)
- [Commit convention](#commit-convention)
- [Pull requests](#pull-requests)
- [Adding an event type](#adding-an-event-type)
- [Adding an integration](#adding-an-integration)
- [Updating schemas](#updating-schemas)
- [Database migrations](#database-migrations)
- [Release process](#release-process)

## Prerequisites

| Tool    | Version                                   | Notes                                                                                           |
| ------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Node.js | `>= 22.12` (24 LTS is the primary target) | `.nvmrc` / `.node-version` pin the recommended version                                          |
| pnpm    | `10.x`                                    | Enable with `corepack enable`; the exact version is pinned in `package.json` (`packageManager`) |
| Git     | any recent                                |                                                                                                 |
| Docker  | optional                                  | Only needed to run against a real PostgreSQL via `docker compose up`                            |

No database server is required for day-to-day development: the API embeds
[PGlite](https://pglite.dev) and stores data in `.shadow/data` when `DATABASE_URL` is unset.

## Install

```bash
git clone https://github.com/arnavsharmaa/shadow.git
cd shadow
corepack enable
pnpm install
cp .env.example .env   # optional; defaults work out of the box
pnpm dev               # starts the API (http://localhost:4000) and the web app (http://localhost:3000)
```

`pnpm dev` runs every workspace `dev` task through Turborepo. On first start the API applies
migrations (`SHADOW_AUTO_MIGRATE=true`) and, if the database is empty, seeds the deterministic demo
data set (`SHADOW_AUTO_SEED=true`). `pnpm demo` runs the canonical refund-agent demo end to end.

## Repository layout

```
apps/
  api/            Fastify ingestion, query, replay and comparison API (Drizzle + PGlite/Postgres)
  web/            Next.js trace explorer, fork editor and comparison views
packages/
  schemas/        Zod schemas and TypeScript types shared by every package (the source of truth)
  core/           Engine: event log, state reconstruction, forks, replay, comparison, redaction, pricing
  sdk/            @shadow/sdk instrumentation library used by agent code
  cli/            @shadow/cli (`shadow` binary)
  testkit/        Deterministic agent scenarios, mock adapters and demo data
  config/         Shared TypeScript, ESLint and Prettier configuration
examples/         Runnable example agents instrumented with the SDK
docs/             Concepts, architecture, integrations and ADRs (see docs/README.md)
```

See [docs/architecture/overview.md](./docs/architecture/overview.md) for package boundaries and
the data flow.

## Development workflow

Useful root commands (all run through Turborepo where applicable):

| Command                             | What it does                                                  |
| ----------------------------------- | ------------------------------------------------------------- |
| `pnpm dev`                          | Start the API and web app in watch mode                       |
| `pnpm demo`                         | Run the refund-agent demo (record, fork, replay, compare)     |
| `pnpm lint`                         | ESLint across all packages                                    |
| `pnpm format` / `pnpm format:check` | Prettier write / check                                        |
| `pnpm typecheck`                    | `tsc --noEmit` for every package                              |
| `pnpm test`                         | Unit tests (Vitest)                                           |
| `pnpm test:integration`             | API integration tests against PGlite or `DATABASE_URL`        |
| `pnpm test:e2e`                     | Web end-to-end tests                                          |
| `pnpm bench`                        | Core engine benchmarks on large synthetic traces              |
| `pnpm build`                        | Build every package                                           |
| `pnpm check`                        | `lint` + `format:check` + `typecheck` + `test` (what CI runs) |
| `pnpm db:migrate`                   | Apply pending migrations                                      |
| `pnpm db:seed`                      | (Re)create the demo traces                                    |
| `pnpm db:reset`                     | Drop all Shadow tables, migrate and seed                      |
| `pnpm db:generate`                  | Generate a migration from `apps/api/src/db/schema.ts`         |

Run a single package with a filter, for example `pnpm --filter @shadow/core test`.

Before opening a pull request run `pnpm check`. Prettier and ESLint configuration lives in
`packages/config`; editors that read `.editorconfig` and `.prettierrc` will match the project
style automatically.

## Branches

Shadow uses GitHub flow:

- `main` is always releasable. CI must be green before anything lands on it.
- Work happens on short-lived feature branches created from `main`, for example
  `feat/langgraph-adapter` or `fix/replay-cursor-drain`.
- Changes reach `main` only through pull requests with at least one approving review.
- Rebase or squash before merge so history stays linear; do not merge `main` back into your
  branch repeatedly, rebase instead.

## Testing

Tests are written with [Vitest](https://vitest.dev). Layers:

- **Unit** (`pnpm test`): pure logic in `packages/core`, `packages/schemas`, `packages/sdk`,
  `packages/cli`, `packages/testkit` and `apps/api/test/unit`. These must be deterministic and
  fast; use `VirtualClock` and `seededIdGenerator` from `@shadow/core` instead of wall-clock time
  or random ids.
- **Integration** (`pnpm test:integration`): `apps/api/test/integration` boots the Fastify app
  against a database. With `DATABASE_URL` unset an in-memory PGlite instance is used; set
  `DATABASE_URL=postgres://...` to run against PostgreSQL (CI does both).
- **End-to-end** (`pnpm test:e2e`): browser tests for the web app against a seeded API.
- **Benchmarks** (`pnpm bench`): `packages/core/bench` measures reconstruction, replay and
  comparison on large traces generated by the `synthetic-load-agent` scenario. Benchmarks are
  not run in CI; run them when touching hot paths (ordering, reconstruction, alignment).

Guidelines:

- Every bug fix should come with a regression test.
- Replay changes must keep the bundled scenarios byte-identical: the seed re-records and replays
  them, and the integration suite asserts the results. If a change intentionally alters the demo
  output, say so in the PR.
- Prefer the deterministic adapters in `@shadow/testkit` (`ScriptedModelAdapter`,
  `MockToolAdapter`, `RuleBasedPolicyAdapter`) over ad-hoc mocks.

## Commit convention

Shadow follows [Conventional Commits](https://www.conventionalcommits.org):

```
<type>(<scope>): <short summary>

<body: what and why, not how>

<footer: BREAKING CHANGE:, Refs #123, Closes #456>
```

Types: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.
Scopes are package or area names: `core`, `schemas`, `sdk`, `cli`, `api`, `web`, `testkit`,
`docs`, `deps`. Examples:

```
feat(core): align comparison suffixes with windowed greedy fallback
fix(api): return 422 instead of 500 when forking from a replay event
docs(concepts): document tool_error override semantics
```

A `BREAKING CHANGE:` footer (or `!` after the type) is required for any change that breaks a
public API or the stored trace schema. The changelog is assembled from these messages.

Commits are authored by people. Do not add tooling attribution trailers or co-author lines for
automated assistants.

## Pull requests

1. Open an issue first for anything larger than a small fix so the approach can be discussed.
2. Keep pull requests focused. Separate refactors from behaviour changes.
3. Fill in the [pull request template](./.github/PULL_REQUEST_TEMPLATE.md): what changed, why,
   how it was tested, screenshots for UI changes, breaking changes and documentation updates.
4. Add a line to the `Unreleased` section of [CHANGELOG.md](./CHANGELOG.md) for user-visible
   changes.
5. Make sure `pnpm check` passes locally and CI is green.
6. Respond to review comments with follow-up commits; the branch is squashed at merge time.

Maintainers label pull requests using the taxonomy in
[docs/github-labels.md](./docs/github-labels.md).

## Adding an event type

Event types are open strings of the form `category.action`, so integrations can emit new types
without changing Shadow. Add a type to the _known_ list only when the engine or UI needs to
understand it. Steps:

1. **Schema.** Append the type to `EVENT_TYPES` in `packages/schemas/src/events.ts` and add a
   typed payload schema next to the others (`z.looseObject` so producers can attach extra data).
   If the event opens a span, register it in `SPAN_OPENERS`.
2. **Core handling.** Decide how the engine treats it:
   - state reconstruction: add it to `STATE_MUTATING_EVENT_TYPES` in
     `packages/core/src/state/reconstruct.ts` and handle its payload;
   - replay: if the program performs the operation, add it to `OP_EVENT_TYPES` in
     `packages/core/src/runtime/history.ts` and serve it from history in
     `packages/core/src/runtime/host.ts`;
   - forks: if it closes an operation, add it to `CLOSER_TYPES` in
     `packages/core/src/branches/fork.ts` so forks normalise to the opener;
   - metrics and comparison: update `aggregateMetrics` and `summariseToolCalls` /
     `policyDecisions` in `packages/core/src/comparison/compare.ts` if the type carries usage,
     cost or decisions.
3. **SDK.** Expose a way to emit it from `packages/sdk/src/trace.ts` if agent code should record
   it, mirroring the core runtime so recorded and replayed traces have the same shape.
4. **Tests.** Cover the payload schema, reconstruction and replay behaviour.
5. **Docs.** Document the type, its payload and its span semantics in
   [docs/concepts/events.md](./docs/concepts/events.md). Adding a known type is a MINOR schema
   change (see [Updating schemas](#updating-schemas)).

## Adding an integration

An integration maps another runtime's execution model onto Shadow events. Today there are two
integration paths: instrumenting code with `@shadow/sdk` (which implements the `AgentHost`
contract from `packages/schemas/src/host.ts`) and importing a `shadow.trace` bundle through
`POST /api/v1/traces/import`. Framework adapters are planned for v0.2 (see
[ROADMAP.md](./ROADMAP.md)).

To propose or build one:

1. Read [docs/integrations/README.md](./docs/integrations/README.md) for the vendor-neutral
   mapping principles and the `AgentHost` contract.
2. Deterministic adapters (`ModelAdapter`, `ToolAdapter`, `PolicyAdapter`, `ApprovalAdapter`)
   live in `packages/core/src/runtime/types.ts`; reference implementations are in
   `packages/testkit/src/adapters.ts`. Framework adapters should live in their own workspace
   package (for example `packages/adapter-<framework>`) that depends on `@shadow/schemas` and,
   if it needs the engine, `@shadow/core`.
3. Write the mapping document in `docs/integrations/<framework>.md` following the existing
   proposals: which framework concepts become spans, tool calls, model calls, policy evaluations,
   state and context, and what is lost or approximated.
4. Add a runnable example under `examples/` and, if the integration ships replayable programs,
   register them with the API's `AgentRegistry` (`apps/api/src/replay/registry.ts`).
5. Open an [integration request](./.github/ISSUE_TEMPLATE/integration_request.yml) issue before
   starting large work so the mapping can be reviewed early.

## Updating schemas

`packages/schemas` is the contract between the SDK, the API, the engine, exported bundles and the
web app. The trace schema is versioned independently of package versions with
`SCHEMA_VERSION = "MAJOR.MINOR"` (`packages/schemas/src/version.ts`).

- **MINOR (additive).** New optional fields, new known event types, new override kinds, wider
  enums. Old readers must keep working because they ignore unknown fields (`z.looseObject`) and
  the API stores unknown top-level event fields in the `extra` column. Bump the minor version,
  update [docs/concepts/schema-versioning.md](./docs/concepts/schema-versioning.md) and the
  changelog.
- **MAJOR (breaking).** Renaming or removing fields, changing types or semantics. Requires:
  1. a new `SCHEMA_VERSION` major and an update to `isCompatibleSchemaVersion`;
  2. a data migration for stored events (SQL in `apps/api/drizzle`, plus a TypeScript
     transformation for bundles imported through `POST /traces/import`);
  3. `parseBundle` in `packages/core/src/bundle/bundle.ts` either upgrading or clearly rejecting
     old bundles;
  4. a `BREAKING CHANGE:` footer and a changelog entry.

Never change stored trace semantics without a migration, even before 1.0. Package APIs may
change in a minor release before 1.0; the stored schema may not.

## Database migrations

Shadow uses [Drizzle ORM](https://orm.drizzle.team) with the schema in
`apps/api/src/db/schema.ts` and SQL migrations in `apps/api/drizzle`. The same migrations run on
embedded PGlite and PostgreSQL.

1. Edit `apps/api/src/db/schema.ts`.
2. Run `pnpm db:generate` (drizzle-kit) to create `apps/api/drizzle/<n>_<name>.sql` and update
   `apps/api/drizzle/meta`.
3. Review the generated SQL. Keep migrations additive and reversible where possible; add
   backfills as separate statements.
4. Apply it locally with `pnpm db:migrate` (or restart the API with `SHADOW_AUTO_MIGRATE=true`)
   and run `pnpm test:integration`.
5. Commit the SQL file and the `meta` directory together with the schema change. Never edit a
   migration that has already been released; add a new one.

`pnpm db:reset` drops every Shadow table, re-applies all migrations and seeds the demo data. It is
the quickest way to recover from a broken local database.

## Release process

Shadow follows [Semantic Versioning](https://semver.org). Before 1.0, minor versions may contain
breaking changes to package and HTTP APIs (called out in the changelog), but never to the stored
trace schema without a migration.

1. Ensure `main` is green and the `Unreleased` changelog section is complete.
2. Bump the version in every workspace `package.json` (they are released together) and move the
   `Unreleased` entries under a new `## [x.y.z] - YYYY-MM-DD` heading.
3. Open a `chore(release): vx.y.z` pull request; merge it once approved.
4. Tag the merge commit `vx.y.z` and push the tag. CI builds the packages, publishes
   `@shadow/schemas`, `@shadow/core`, `@shadow/sdk`, `@shadow/cli` and `@shadow/testkit` to npm
   and creates a GitHub release from the changelog section.
5. Announce the release and update [ROADMAP.md](./ROADMAP.md).

Questions? Open a discussion or an issue on GitHub.
