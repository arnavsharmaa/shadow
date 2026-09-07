# Architecture Decision Records

An architecture decision record (ADR) captures a significant design decision together with its
context and consequences, so that future contributors understand _why_ Shadow looks the way it
does, not only _what_ it does.

## Index

| ADR                                            | Title                                      | Status   |
| ---------------------------------------------- | ------------------------------------------ | -------- |
| [0001](./0001-event-sourced-trace-model.md)    | Event-sourced trace model                  | Accepted |
| [0002](./0002-typescript-monorepo.md)          | TypeScript monorepo                        | Accepted |
| [0003](./0003-deterministic-vs-live-replay.md) | Deterministic versus live replay           | Accepted |
| [0004](./0004-postgres-initial-storage.md)     | PostgreSQL (and PGlite) as initial storage | Accepted |

## When to write an ADR

Write one when a decision:

- is hard or expensive to reverse (storage engine, wire format, schema versioning policy);
- constrains how other parts of the system are built (package boundaries, the `AgentHost`
  contract);
- was contentious, or where the obvious alternative was rejected for non-obvious reasons.

Small, local decisions belong in code comments or pull request descriptions, not ADRs.

## Process

1. Copy the template below to `docs/adr/NNNN-short-title.md` using the next free number.
2. Open a pull request. Discussion happens in the review; the ADR is merged with status
   **Proposed** or **Accepted** depending on the outcome.
3. ADRs are immutable once accepted. To change a decision, write a new ADR that supersedes the
   old one and update the old record's status to **Superseded by NNNN**.

Statuses: `Proposed`, `Accepted`, `Deprecated`, `Superseded by NNNN`.

## Template

```markdown
# NNNN. Title

- **Status:** Proposed | Accepted | Deprecated | Superseded by NNNN
- **Date:** YYYY-MM-DD
- **Deciders:** names or roles

## Context

What problem are we solving? What forces are at play (technical, product, organisational)?
State facts, constraints and assumptions. Link to issues, benchmarks or prototypes.

## Decision

What we decided, stated in full sentences ("We will ..."). Include the essential shape of the
solution, not implementation detail that will drift.

## Consequences

What becomes easier or harder as a result. List positive, negative and neutral consequences,
and any follow-up work the decision commits us to.

## Alternatives considered

For each alternative: a short description and the reason it was not chosen.
```
