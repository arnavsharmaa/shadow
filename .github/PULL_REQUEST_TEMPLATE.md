<!--
Thank you for contributing to Shadow. Please read CONTRIBUTING.md first.
Keep the pull request focused; open separate PRs for unrelated changes.
-->

## What changed?

<!-- A short summary of the change. Link the issue it addresses: "Closes #123". -->

## Why?

<!-- The problem this solves or the motivation. For design decisions, link the ADR or discussion. -->

## How was it tested?

<!--
Which of these did you run, and what did you add?
- `pnpm test` (unit)          - `pnpm test:integration` (PGlite and/or DATABASE_URL)
- `pnpm test:e2e`             - `pnpm bench` (for hot-path changes)
- Manual steps (commands, request bodies, CLI invocations, demo trace used)
-->

## Screenshots (UI changes)

<!-- Before/after screenshots or a short recording for changes to apps/web. Delete if not applicable. -->

## Breaking changes?

<!--
- Public API of a package or the HTTP API: describe the break and the migration for users.
- Trace schema: minor (additive) or major (requires migration)? Reference the migration in apps/api/drizzle
  and the update to docs/concepts/schema-versioning.md. Add a `BREAKING CHANGE:` footer to the commit.
- None: say so.
-->

## Documentation updated?

<!-- Which docs changed (docs/concepts, docs/architecture, docs/integrations, README, CHANGELOG), or why none were needed. -->

## Checklist

- [ ] Commits follow the Conventional Commits format (`type(scope): summary`)
- [ ] `pnpm check` passes locally (lint, format, typecheck, unit tests)
- [ ] Integration tests pass (`pnpm test:integration`) when the API or storage changed
- [ ] New behaviour is covered by tests; bug fixes include a regression test
- [ ] Deterministic demo output is unchanged, or the change is called out above
- [ ] Database migration generated with `pnpm db:generate` and committed (if the schema changed)
- [ ] `CHANGELOG.md` `Unreleased` section updated for user-visible changes
- [ ] No secrets, real customer data or sensitive traces are included in code, tests or fixtures
