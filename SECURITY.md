# Security Policy

## Supported versions

| Version | Supported        |
| ------- | ---------------- |
| 0.1.x   | Yes              |
| < 0.1   | No (pre-release) |

Security fixes are released as patch versions of the latest minor release.

## Reporting a vulnerability

Please report vulnerabilities through
**GitHub private vulnerability reporting**: open the repository's _Security_ tab and choose
_Report a vulnerability_. This creates a private advisory that only the maintainers can see.

Do **not** open a public issue, discussion or pull request for a security problem, and do not
include real traces, credentials or customer data in a report. If a proof of concept requires a
trace, use the deterministic demo data (`pnpm db:seed`) or a synthetic trace.

What to include:

- affected package(s) and version(s);
- a description of the issue and its impact;
- reproduction steps or a minimal proof of concept;
- any suggested mitigation.

We will acknowledge the report, work with you on a fix and credit you in the release notes unless
you prefer to remain anonymous.

## Scope and threat model for v0.1

Shadow v0.1 is a **local, single-user developer tool**. It is designed to run on a developer
machine or inside a trusted network:

- **No authentication or authorisation.** The API (`apps/api`) and the web app accept every
  request. Anyone who can reach the API port can read, create, fork, replay, export and delete
  traces.
- **No encryption at rest.** Events are stored as plain JSON in PGlite (`.shadow/data`) or in the
  PostgreSQL database you point `DATABASE_URL` at.
- **Bind to localhost.** The default `SHADOW_API_HOST` is `127.0.0.1`. Do not expose the API to
  the public internet. If you must share it, put it behind a reverse proxy that enforces
  authentication, restrict `SHADOW_CORS_ORIGINS`, and use network-level controls.
- **Production, multi-tenant deployment is not supported yet.** Authentication, per-project
  authorisation, encryption and audit logging are roadmap items (see
  [ROADMAP.md](./ROADMAP.md)).

## Agent data considerations

Traces capture what an agent saw and did: prompts, model responses, tool arguments and results,
state and context. That routinely includes personal data, business data and, if the agent handles
them, secrets. Treat trace stores and exported `shadow.trace` bundles with the same care as
production logs or database dumps:

- Review what your agent passes through tools and models before instrumenting it.
- Do not commit exported bundles that contain real data to source control.
- Delete traces you no longer need (`DELETE /api/v1/traces/:traceId`).
- Be careful when sharing traces in issues; prefer synthetic reproductions.

## Redaction and its limits

Shadow redacts sensitive values in two places:

- **Client-side** (`@shadow/sdk`), before events leave the process, by key name. Defaults match
  `password`, `passwd`, `api_key`/`apikey`, `authorization`, `secret`, `token`, `cookie`,
  `credential` and `private_key` (case-insensitive). Extra patterns can be passed via the
  `redact` option; `redact: false` disables client-side redaction.
- **Server-side** (`apps/api`), on ingestion and in structured logs, using the same key patterns
  plus `client_secret` and `set-cookie`, value patterns for common credential shapes (bearer
  tokens, `sk-` style keys, GitHub and Slack tokens, AWS access key ids, PEM private keys), and
  any additional key patterns from `SHADOW_REDACT_PATTERNS`.

Redaction is **pattern based** and therefore best effort:

- Values are only redacted when their **key** matches a pattern or the **whole string value**
  matches a known credential shape. A secret embedded inside prose, a prompt, a URL or a
  free-form message is **not** detected.
- Secrets that appear in event `name`s, tags, or non-JSON fields are not redacted.
- Redaction is not reversible, and it cannot protect data that was already sent by a
  misconfigured client.

Do not rely on redaction as your only control. Keep secrets out of agent inputs and outputs, use
short-lived credentials, and scope tool access narrowly.

## Other measures in v0.1

- All API input is validated with Zod schemas; unknown routes and malformed bodies return
  structured errors.
- Request bodies are bounded by `SHADOW_MAX_BODY_BYTES` (default 10 MiB); ingestion batches are
  capped at 5000 events and export bundles at 500 000 events.
- The engine never evaluates code from traces: replay re-runs programs that are registered in the
  API process, not code shipped inside a trace or bundle.
- Structured logs redact known sensitive keys before writing.
- Dependencies are pinned to exact versions in the lockfile.

## Hardening checklist for shared deployments

Until authentication ships, if you run Shadow anywhere other than your own machine:

1. Keep `SHADOW_API_HOST=127.0.0.1` or bind to a private interface.
2. Put an authenticating reverse proxy in front of the API and web app.
3. Set `SHADOW_CORS_ORIGINS` to the exact origins you serve the web app from.
4. Use a dedicated PostgreSQL database with least-privilege credentials and encrypted storage.
5. Configure `SHADOW_REDACT_PATTERNS` for your domain-specific secret keys.
6. Back up and rotate trace data according to your retention policy.
