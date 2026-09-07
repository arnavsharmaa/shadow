# GitHub labels

A small, consistent label taxonomy keeps issues and pull requests triageable. Labels are grouped
by prefix; every issue should carry one `type/` label and at least one `area/` label, and
maintainers add `status/` and `priority/` labels during triage.

Apply the taxonomy to a repository with [`scripts/create-labels.sh`](../scripts/create-labels.sh)
(requires the GitHub CLI, `gh auth login`, and is idempotent thanks to `--force`):

```bash
./scripts/create-labels.sh                 # current repository
./scripts/create-labels.sh owner/repo      # explicit repository
```

## `type/` — what kind of work

| Label              | Colour    | Description                                                                 |
| ------------------ | --------- | --------------------------------------------------------------------------- |
| `type/bug`         | `#d73a4a` | Something does not work as documented                                       |
| `type/feature`     | `#a2eeef` | New capability or enhancement                                               |
| `type/integration` | `#0e8a16` | Request or proposal for a framework/runtime integration                     |
| `type/docs`        | `#0075ca` | Documentation only                                                          |
| `type/refactor`    | `#cfd3d7` | Internal change with no user-visible behaviour change                       |
| `type/performance` | `#fbca04` | Speed, memory or scalability                                                |
| `type/security`    | `#b60205` | Security hardening (never for vulnerability reports; use private reporting) |
| `type/question`    | `#d876e3` | Usage question or support request                                           |
| `type/chore`       | `#ededed` | Tooling, dependencies, CI, release mechanics                                |

## `area/` — which part of Shadow

| Label             | Colour    | Description                                                          |
| ----------------- | --------- | -------------------------------------------------------------------- |
| `area/schemas`    | `#1d76db` | `@shadow/schemas`: event model, entities, overrides, API contracts   |
| `area/core`       | `#1d76db` | `@shadow/core`: state, forks, replay, comparison, redaction, pricing |
| `area/sdk`        | `#1d76db` | `@shadow/sdk`: instrumentation and transports                        |
| `area/cli`        | `#1d76db` | `@shadow/cli`                                                        |
| `area/api`        | `#1d76db` | `apps/api`: routes, services, ingestion                              |
| `area/storage`    | `#1d76db` | Drizzle schema, migrations, PGlite/PostgreSQL                        |
| `area/web`        | `#1d76db` | `apps/web`: explorer, trace detail, fork editor, comparison          |
| `area/replay`     | `#5319e7` | Replay engine, history cursor, determinism                           |
| `area/comparison` | `#5319e7` | Comparison engine and views                                          |
| `area/testkit`    | `#1d76db` | Scenarios, adapters, demo data                                       |
| `area/docs`       | `#1d76db` | `docs/` and top-level documents                                      |
| `area/ci`         | `#1d76db` | Workflows, release automation                                        |

## `status/` — where it is in the process

| Label                 | Colour    | Description                                       |
| --------------------- | --------- | ------------------------------------------------- |
| `status/needs-triage` | `#e4e669` | New; a maintainer has not looked yet              |
| `status/needs-info`   | `#fef2c0` | Waiting for details from the reporter             |
| `status/needs-design` | `#c5def5` | Agreed in principle; design or ADR required first |
| `status/accepted`     | `#0e8a16` | Ready to be worked on                             |
| `status/in-progress`  | `#bfdadc` | Someone is actively working on it                 |
| `status/blocked`      | `#b60205` | Blocked on another issue or external dependency   |
| `status/wontfix`      | `#ffffff` | Will not be addressed; reason in the thread       |
| `status/duplicate`    | `#cfd3d7` | Duplicate of another issue                        |

## `priority/` — how urgent

| Label               | Colour    | Description                                                        |
| ------------------- | --------- | ------------------------------------------------------------------ |
| `priority/critical` | `#b60205` | Data loss, wrong counterfactual results, security; fix immediately |
| `priority/high`     | `#d93f0b` | Important for the next release                                     |
| `priority/medium`   | `#fbca04` | Should be done; not release blocking                               |
| `priority/low`      | `#0e8a16` | Nice to have                                                       |

## Community labels

| Label              | Colour    | Description                                           |
| ------------------ | --------- | ----------------------------------------------------- |
| `good first issue` | `#7057ff` | Small, well-scoped, suitable for a first contribution |
| `help wanted`      | `#008672` | Maintainers would welcome a contribution              |
| `breaking-change`  | `#b60205` | Changes a public API or requires a schema migration   |
| `schema-change`    | `#5319e7` | Touches the trace schema version (minor or major)     |

## Triage guidelines

- New issues from the templates arrive with a `type/` label and `status/needs-triage`. Triage
  adds `area/`, `priority/` and moves the status to `accepted`, `needs-info`, `needs-design` or
  closes it.
- `breaking-change` and `schema-change` are also applied to pull requests and are checked
  during release notes assembly.
- Security vulnerability reports must never become public issues; see
  [SECURITY.md](../SECURITY.md). `type/security` is for hardening work only.
- Use `status/needs-design` for anything that should have an ADR before implementation (see
  [docs/adr/README.md](./adr/README.md)).
