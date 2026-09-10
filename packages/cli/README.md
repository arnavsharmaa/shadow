# @shadow/cli

Command-line client for the [Shadow](../../README.md) API.

```bash
shadow --version
shadow --help
shadow status [--json]
shadow traces list [--project <slug>] [--agent <slug>] [--status <s>] [--tag <t>] [--tool <name>] [-q <text>] [--limit <n>] [--json]
shadow traces inspect <traceId> [--branch <branchId>] [--json]
shadow traces export <traceId> [--out <file>]
shadow traces import <file> [--regenerate-ids]
shadow fork <traceId> --at <eventId> [--set key=value ...] [--unset key ...] [--state /path=value ...]
                      [--tool-result tool=json ...] [--tool-error tool=message ...] [--policy id=json ...]
                      [--name <name>] [--replay] [--json]
shadow replay <branchId> [--json]
shadow compare <baseBranchId> <targetBranchId> [--json]
```

Global options: `--endpoint <url>` (default `SHADOW_ENDPOINT` or `http://localhost:4000`) and `--token <token>` (default `SHADOW_TOKEN`) for APIs started with `SHADOW_API_TOKEN`.

Exit codes: `0` success, `1` error, `2` usage error, `3` API unreachable, `4` resource not found.

Inside the monorepo: `pnpm --filter @shadow/cli exec tsx src/cli.ts <args>`; after `pnpm build`: `packages/cli/bin/shadow.js`.

License: Apache-2.0
