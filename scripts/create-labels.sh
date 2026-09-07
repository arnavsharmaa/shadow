#!/usr/bin/env bash
#
# Create (or update) the Shadow label taxonomy on a GitHub repository.
#
# Usage:
#   ./scripts/create-labels.sh              # repository of the current directory
#   ./scripts/create-labels.sh owner/repo   # explicit repository
#
# Requires the GitHub CLI (https://cli.github.com) authenticated with `gh auth login`.
# The script is idempotent: `gh label create --force` updates colour and description
# of labels that already exist. See docs/github-labels.md for the taxonomy.

set -euo pipefail

if ! command -v gh >/dev/null 2>&1; then
  echo "error: the GitHub CLI (gh) is required" >&2
  exit 1
fi

REPO_ARGS=()
if [[ $# -ge 1 ]]; then
  REPO_ARGS=(--repo "$1")
fi

# name|colour (without #)|description
LABELS=(
  # type/
  "type/bug|d73a4a|Something does not work as documented"
  "type/feature|a2eeef|New capability or enhancement"
  "type/integration|0e8a16|Request or proposal for a framework/runtime integration"
  "type/docs|0075ca|Documentation only"
  "type/refactor|cfd3d7|Internal change with no user-visible behaviour change"
  "type/performance|fbca04|Speed, memory or scalability"
  "type/security|b60205|Security hardening (report vulnerabilities privately, not here)"
  "type/question|d876e3|Usage question or support request"
  "type/chore|ededed|Tooling, dependencies, CI, release mechanics"
  # area/
  "area/schemas|1d76db|@shadow/schemas: event model, entities, overrides, API contracts"
  "area/core|1d76db|@shadow/core: state, forks, replay, comparison, redaction, pricing"
  "area/sdk|1d76db|@shadow/sdk: instrumentation and transports"
  "area/cli|1d76db|@shadow/cli"
  "area/api|1d76db|apps/api: routes, services, ingestion"
  "area/storage|1d76db|Drizzle schema, migrations, PGlite/PostgreSQL"
  "area/web|1d76db|apps/web: explorer, trace detail, fork editor, comparison"
  "area/replay|5319e7|Replay engine, history cursor, determinism"
  "area/comparison|5319e7|Comparison engine and views"
  "area/testkit|1d76db|Scenarios, adapters, demo data"
  "area/docs|1d76db|docs/ and top-level documents"
  "area/ci|1d76db|Workflows, release automation"
  # status/
  "status/needs-triage|e4e669|New; a maintainer has not looked yet"
  "status/needs-info|fef2c0|Waiting for details from the reporter"
  "status/needs-design|c5def5|Agreed in principle; design or ADR required first"
  "status/accepted|0e8a16|Ready to be worked on"
  "status/in-progress|bfdadc|Someone is actively working on it"
  "status/blocked|b60205|Blocked on another issue or external dependency"
  "status/wontfix|ffffff|Will not be addressed; reason in the thread"
  "status/duplicate|cfd3d7|Duplicate of another issue"
  # priority/
  "priority/critical|b60205|Data loss, wrong counterfactual results, security; fix immediately"
  "priority/high|d93f0b|Important for the next release"
  "priority/medium|fbca04|Should be done; not release blocking"
  "priority/low|0e8a16|Nice to have"
  # community
  "good first issue|7057ff|Small, well-scoped, suitable for a first contribution"
  "help wanted|008672|Maintainers would welcome a contribution"
  "breaking-change|b60205|Changes a public API or requires a schema migration"
  "schema-change|5319e7|Touches the trace schema version (minor or major)"
)

created=0
for entry in "${LABELS[@]}"; do
  IFS='|' read -r name colour description <<<"$entry"
  gh label create "$name" \
    --color "$colour" \
    --description "$description" \
    --force \
    ${REPO_ARGS[@]+"${REPO_ARGS[@]}"}
  created=$((created + 1))
done

echo "ensured ${created} labels"
