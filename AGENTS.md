# AGENTS.md

Guidance for coding agents (and humans) working on Shadow. Keep this file short and accurate; update it when the architecture changes.

## What Shadow is

Time-travel debugging for AI agents: record executions as append-only event traces, reconstruct state at any event, fork from any decision with typed overrides, replay deterministically, and compare branches. See `README.md` and `docs/`.

## Repository layout

| Path               | Package           | Role                                                                                                              |
| ------------------ | ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| `packages/schemas` | `@shadow/schemas` | Zod schemas + TypeScript types for events, entities, overrides, comparisons, API contracts, `AgentHost` contract  |
| `packages/core`    | `@shadow/core`    | Engine: ordering, state reconstruction, forks, replay (history cursor + adapters), comparison, redaction, pricing |
| `packages/testkit` | `@shadow/testkit` | Deterministic scenario agents, mock adapters, demo data                                                           |
| `packages/sdk`     | `@shadow/sdk`     | Instrumentation SDK (`Shadow`, `Trace`, transports)                                                               |
| `packages/cli`     | `@shadow/cli`     | `shadow` command-line client for the HTTP API                                                                     |
| `packages/config`  | `@shadow/config`  | Shared tsconfig / ESLint presets                                                                                  |
| `apps/api`         | `@shadow/api`     | Fastify API, Drizzle/PostgreSQL (or embedded PGlite), migrations, seed, replay registry                           |
| `apps/web`         | `@shadow/web`     | Next.js UI: explorer, trace detail, fork editor, branch graph, comparison                                         |
| `examples/*`       | –                 | SDK examples                                                                                                      |
| `docs/`            | –                 | Architecture, concepts, integrations, ADRs                                                                        |

## Package boundaries (enforced by ESLint `no-restricted-imports`)

- `@shadow/core` must not import Next.js, React, Fastify, Drizzle or `pg`. Business logic only.
- `@shadow/sdk` must not import `@shadow/core` or any app. It depends only on `@shadow/schemas`.
- `@shadow/schemas` has no workspace dependencies.
- `apps/api` coordinates persistence + HTTP and calls into `@shadow/core`; it never contains replay/comparison logic of its own.
- `apps/web` renders; comparison and reconstruction results come from the API. It may import pure helpers from `@shadow/core`.
- No circular workspace dependencies (`turbo` will refuse to run).

## Commands

```bash
pnpm install            # Node >= 22.12 (24 LTS recommended), pnpm 10 via corepack
pnpm dev                # API (http://localhost:4000) + web (http://localhost:3000), embedded PGlite
pnpm demo               # migrate + seed demo data, then dev
pnpm lint / pnpm format:check / pnpm typecheck
pnpm test               # unit tests (vitest) in every package
pnpm test:integration   # API integration tests (PGlite; set DATABASE_URL for PostgreSQL)
pnpm test:e2e           # Playwright, boots isolated API + web on ports 4100/3100
pnpm build              # production builds
pnpm db:migrate / db:seed / db:reset / db:generate
pnpm bench              # ~10k event benchmark
```

## Coding standards

- TypeScript strict; no `any`, no non-null assertions, no `eval`/dynamic code execution. Prefer explicit guards and typed casts.
- All external input is validated with Zod (`@shadow/schemas`). API routes declare Zod schemas; never trust request bodies.
- Payloads are JSON (`JsonValue`). Use `toJson` before storing values produced by user code.
- Events are append-only. Never mutate stored events; add new event types instead of changing the meaning of existing ones.
- Determinism matters: seeds, virtual clocks and seeded ids must stay stable. If you change event emission order or payload shape in the runtime, expect the fixed-expectation tests to tell you.
- Keep secrets out of the repo. Redaction runs client-side (SDK) and server-side (API); extend `DEFAULT_KEY_PATTERNS` when adding new sensitive fields.
- Conventional commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, `perf:`, `ci:`).
- Prettier formats everything (`pnpm format`).

## Schema and migration rules

- `packages/schemas/src/version.ts` holds `SCHEMA_VERSION` (`MAJOR.MINOR`). Additive changes bump MINOR; anything that changes the meaning of existing fields bumps MAJOR and needs a migration (see `docs/concepts/schema-versioning.md`).
- New event types: add to `EVENT_TYPES` in `packages/schemas/src/events.ts`, add a payload schema, handle it where relevant (`reconstructState`, `HistoryCursor.OP_EVENT_TYPES` if the program emits it, comparison), document it in `docs/concepts/events.md`, and add tests.
- Database changes: edit `apps/api/src/db/schema.ts`, run `pnpm db:generate` (drizzle-kit) and commit the generated SQL in `apps/api/drizzle/`. Never edit generated migrations by hand once merged; never delete the migration journal.

## Definition of done

A change is done when all of the following hold:

1. `pnpm lint`, `pnpm format:check`, `pnpm typecheck` pass.
2. `pnpm test` and `pnpm test:integration` pass; new behaviour has tests that would fail without the change.
3. `pnpm build` succeeds.
4. UI changes keep `pnpm test:e2e` green and remain keyboard accessible (visible focus, labels, dialogs built on `<dialog>`).
5. Docs are updated (`docs/`, `README.md`, `CHANGELOG.md` under `[Unreleased]`).
6. No lint rules, type checks, tests or coverage thresholds were disabled, skipped or loosened to make the build pass. If a check is wrong, fix the check in its own commit with an explanation.

## Files not to modify casually

- `apps/api/drizzle/**` (generated migrations; see rules above)
- `packages/schemas/src/version.ts` (schema version; requires an ADR-level decision)
- `packages/core/src/runtime/history.ts` and `host.ts` (replay determinism; changes ripple into every recorded trace)
- `.github/workflows/*` (pinned action SHAs and minimal permissions are deliberate)
- `LICENSE`

## Demo data

`packages/testkit/src/demo.ts` defines the seeded traces; `apps/api/src/seed/seed.ts` records, forks, replays and compares them deterministically. `trc_demo_refund_violation` is the canonical example used by the E2E suite and the README.
