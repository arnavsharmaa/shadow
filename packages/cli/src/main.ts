import { readFile, writeFile } from "node:fs/promises";
import { buildEventTree, flattenTree } from "@shadow/core";
import type {
  Branch,
  Comparison,
  Fork,
  Override,
  Replay,
  ShadowEvent,
  TraceExport,
  TraceSummary,
} from "@shadow/schemas";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { ApiClient, CliError, EXIT } from "./client.js";
import { duration, money, parseAssignment, percent, table, truncate } from "./format.js";

export const CLI_VERSION = "0.1.0";

export interface RunOptions {
  fetch?: typeof fetch;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  env?: Record<string, string | undefined>;
}

interface Page<T> {
  items: T[];
  nextCursor: string | null;
  total?: number;
}

/** Run the CLI with the given arguments; returns the process exit code. */
export async function run(argv: string[], options: RunOptions = {}): Promise<number> {
  const out = options.stdout ?? ((text) => process.stdout.write(`${text}\n`));
  const err = options.stderr ?? ((text) => process.stderr.write(`${text}\n`));
  const env = options.env ?? process.env;
  const program = new Command();
  program
    .name("shadow")
    .description("Shadow: time-travel debugging for AI agents.")
    .version(CLI_VERSION, "-v, --version", "print the CLI version")
    .option(
      "--endpoint <url>",
      "Shadow API base URL",
      env.SHADOW_ENDPOINT ?? "http://localhost:4000",
    )
    .exitOverride()
    .configureOutput({ writeOut: (s) => out(s.trimEnd()), writeErr: (s) => err(s.trimEnd()) })
    .showHelpAfterError("(use --help for usage)");

  const client = () =>
    new ApiClient({
      endpoint: program.opts<{ endpoint: string }>().endpoint,
      fetch: options.fetch,
    });
  const json = (value: unknown) => out(JSON.stringify(value, null, 2));

  program
    .command("status")
    .description("check the Shadow API and summarise what it holds")
    .option("--json", "print JSON")
    .action(async (opts: { json?: boolean }) => {
      const api = client();
      const health = await api.get<{
        status: string;
        version: string;
        uptimeSeconds: number;
        database: { kind: string; location: string; healthy: boolean };
      }>("/health");
      const traces = await api.get<Page<TraceSummary>>("/api/v1/traces", { limit: 1 });
      const facets = await api.get<{
        projects: { slug: string }[];
        agents: { slug: string }[];
        tools: string[];
      }>("/api/v1/traces/facets");
      const summary = {
        endpoint: program.opts<{ endpoint: string }>().endpoint,
        status: health.status,
        version: health.version,
        uptimeSeconds: health.uptimeSeconds,
        database: health.database,
        traces: traces.total ?? traces.items.length,
        projects: facets.projects.length,
        agents: facets.agents.length,
        tools: facets.tools.length,
      };
      if (opts.json) return json(summary);
      out(
        `shadow api ${summary.version} at ${summary.endpoint}: ${summary.status} (up ${duration(summary.uptimeSeconds * 1000)})`,
      );
      out(
        `  database  ${summary.database.kind} ${summary.database.location} (${summary.database.healthy ? "healthy" : "unhealthy"})`,
      );
      out(
        `  traces    ${summary.traces} across ${summary.projects} project(s) and ${summary.agents} agent(s); ${summary.tools} distinct tool(s)`,
      );
      if (summary.status !== "ok")
        throw new CliError("the API reports a degraded status", EXIT.error);
    });

  const traces = program.command("traces").description("list, inspect, export and import traces");

  traces
    .command("list")
    .description("list recorded traces")
    .option("--project <slug>", "filter by project slug")
    .option("--agent <slug>", "filter by agent slug")
    .option("--status <status>", "running | completed | failed")
    .option("--tag <tag>", "filter by tag")
    .option("--tool <name>", "traces that called a tool")
    .option("-q, --query <text>", "free-text search")
    .option("--limit <n>", "maximum rows", positiveInt, 25)
    .option("--json", "print JSON instead of a table")
    .action(
      async (opts: {
        project?: string;
        agent?: string;
        status?: string;
        tag?: string;
        tool?: string;
        query?: string;
        limit: number;
        json?: boolean;
      }) => {
        const page = await client().get<Page<TraceSummary>>("/api/v1/traces", {
          project: opts.project,
          agent: opts.agent,
          status: opts.status,
          tag: opts.tag,
          tool: opts.tool,
          q: opts.query,
          limit: opts.limit,
        });
        if (opts.json) return json(page);
        if (page.items.length === 0) return out("no traces found");
        out(
          table(
            [
              "TRACE",
              "PROJECT",
              "AGENT",
              "NAME",
              "STATUS",
              "STARTED",
              "DURATION",
              "TOOLS",
              "TOKENS",
              "EST. COST",
              "BRANCHES",
            ],
            page.items.map((t) => [
              t.id,
              t.projectSlug,
              t.agentSlug,
              truncate(t.name, 40),
              t.status,
              t.startedAt,
              duration(t.durationMs),
              String(t.metrics.toolCalls),
              String(t.metrics.totalTokens),
              money(t.metrics.totalEstimatedCost, t.metrics.currency),
              String(t.branchCount),
            ]),
          ),
        );
        out(
          `${page.items.length} of ${page.total ?? page.items.length} traces${page.nextCursor ? " (more available; raise --limit)" : ""}`,
        );
      },
    );

  traces
    .command("inspect")
    .description("show a trace, its branches and its event timeline")
    .argument("<traceId>", "trace id")
    .option("--branch <branchId>", "branch to inspect (default: main)")
    .option("--json", "print JSON instead of text")
    .action(async (traceId: string, opts: { branch?: string; json?: boolean }) => {
      const api = client();
      const detail = await api.get<{ trace: TraceSummary; branches: Branch[] }>(
        `/api/v1/traces/${encodeURIComponent(traceId)}`,
      );
      const branchId = opts.branch ?? detail.trace.rootBranchId;
      const events = await allEvents(api, traceId, branchId);
      if (opts.json) return json({ ...detail, branchId, events });
      const t = detail.trace;
      out(`${t.name}`);
      out(`  trace     ${t.id}`);
      out(`  project   ${t.projectSlug}    agent ${t.agentSlug}`);
      out(`  status    ${t.status}${t.outcome ? ` (${t.outcome.label})` : ""}`);
      out(`  started   ${t.startedAt}    duration ${duration(t.durationMs)}`);
      out(
        `  usage     ${t.metrics.modelCalls} model calls, ${t.metrics.toolCalls} tool calls, ${t.metrics.totalTokens} tokens, est. cost ${money(t.metrics.totalEstimatedCost, t.metrics.currency)}`,
      );
      out(`  tags      ${t.tags.join(", ") || "-"}`);
      out("");
      out("branches");
      out(
        table(
          ["BRANCH", "NAME", "PARENT", "FORK SEQ", "STATUS", "OUTCOME", "EST. COST", "DURATION"],
          detail.branches.map((b) => [
            b.id,
            b.name,
            b.parentBranchId ?? "-",
            b.forkSequence === null ? "-" : String(b.forkSequence),
            b.status,
            b.outcome?.label ?? "-",
            money(b.metrics.totalEstimatedCost, b.metrics.currency),
            duration(b.metrics.durationMs),
          ]),
        ),
      );
      out("");
      out(`events (branch ${branchId})`);
      const nodes = flattenTree(buildEventTree(events));
      for (const node of nodes) {
        const e = node.event;
        const indent = "  ".repeat(node.depth);
        const extra = describeEvent(e);
        out(
          `${String(e.sequence).padStart(4)}  ${indent}${e.eventType.padEnd(26)} ${e.name}${extra ? `  ${extra}` : ""}`,
        );
      }
    });

  traces
    .command("export")
    .description("export a trace (all branches) as a portable JSON bundle")
    .argument("<traceId>", "trace id")
    .option("-o, --out <file>", "write to a file instead of stdout")
    .action(async (traceId: string, opts: { out?: string }) => {
      const bundle = await client().get<TraceExport>(
        `/api/v1/traces/${encodeURIComponent(traceId)}/export`,
      );
      const text = JSON.stringify(bundle, null, 2);
      if (opts.out) {
        await writeFile(opts.out, text, "utf8");
        out(
          `wrote ${bundle.events.length} events (${bundle.branches.length} branches) to ${opts.out}`,
        );
      } else {
        out(text);
      }
    });

  traces
    .command("import")
    .description("import a previously exported trace bundle")
    .argument("<file>", "path to a .json bundle")
    .option("--regenerate-ids", "assign fresh ids (import a copy)")
    .action(async (file: string, opts: { regenerateIds?: boolean }) => {
      let raw: unknown;
      try {
        raw = JSON.parse(await readFile(file, "utf8"));
      } catch (error) {
        throw new CliError(
          `could not read ${file}: ${error instanceof Error ? error.message : String(error)}`,
          EXIT.usage,
        );
      }
      const trace = await client().post<{ id: string; branchCount: number }>(
        "/api/v1/traces/import",
        {
          bundle: raw,
          idStrategy: opts.regenerateIds ? "regenerate" : "keep",
        },
      );
      out(`imported trace ${trace.id} (${trace.branchCount} branches)`);
    });

  program
    .command("fork")
    .description("create a branch that diverges before an event, with overrides")
    .argument("<traceId>", "trace id")
    .requiredOption("--at <eventId>", "event to rewind to (it is re-executed on the new branch)")
    .option("--branch <branchId>", "parent branch (default: the event's branch)")
    .option("--name <name>", "branch name (default: fork-N)")
    .option("--set <key=value...>", "context override, e.g. --set refundLimit=100")
    .option("--unset <key...>", "remove a context key")
    .option(
      "--state <path=value...>",
      'state override by JSON pointer, e.g. --state /customer/tier="enterprise"',
    )
    .option("--tool-result <tool=json...>", "replace the next result of a tool")
    .option("--tool-error <tool=message...>", "make the next call of a tool fail")
    .option("--policy <policy=json...>", "override a policy's configuration")
    .option("--replay", "run the deterministic replay immediately")
    .option("--json", "print JSON")
    .action(
      async (
        traceId: string,
        opts: {
          at: string;
          branch?: string;
          name?: string;
          set?: string[];
          unset?: string[];
          state?: string[];
          toolResult?: string[];
          toolError?: string[];
          policy?: string[];
          replay?: boolean;
          json?: boolean;
        },
      ) => {
        const overrides: Override[] = [];
        for (const item of opts.set ?? []) {
          const { key, value } = parseAssignment(item);
          overrides.push({
            kind: "context",
            op: "set",
            key,
            value: value as Override extends { value?: infer V } ? V : never,
          });
        }
        for (const key of opts.unset ?? []) overrides.push({ kind: "context", op: "remove", key });
        for (const item of opts.state ?? []) {
          const { key, value } = parseAssignment(item);
          overrides.push({ kind: "state", op: "set", path: key, value: value as never });
        }
        for (const item of opts.toolResult ?? []) {
          const { key, value } = parseAssignment(item);
          overrides.push({ kind: "tool_result", tool: key, occurrence: 1, result: value as never });
        }
        for (const item of opts.toolError ?? []) {
          const { key, value } = parseAssignment(item);
          overrides.push({
            kind: "tool_error",
            tool: key,
            occurrence: 1,
            error: { message: String(value) },
          });
        }
        for (const item of opts.policy ?? []) {
          const { key, value } = parseAssignment(item);
          if (value === null || typeof value !== "object" || Array.isArray(value)) {
            throw new CliError(`--policy value for ${key} must be a JSON object`, EXIT.usage);
          }
          overrides.push({ kind: "policy", policy: key, config: value as never });
        }
        const api = client();
        const result = await api.post<{ branch: Branch; fork: Fork }>(
          `/api/v1/traces/${encodeURIComponent(traceId)}/forks`,
          {
            forkEventId: opts.at,
            parentBranchId: opts.branch,
            name: opts.name,
            overrides,
          },
        );
        let replay: Replay | undefined;
        let branch = result.branch;
        if (opts.replay) {
          const replayed = await api.post<{ replay: Replay; branch: Branch }>(
            `/api/v1/branches/${encodeURIComponent(branch.id)}/replay`,
            { mode: "deterministic" },
          );
          replay = replayed.replay;
          branch = replayed.branch;
        }
        if (opts.json) return json({ ...result, branch, replay });
        out(
          `created branch ${branch.name} (${branch.id}) forking before ${result.fork.forkEventId} (inherits sequences <= ${result.fork.forkSequence})`,
        );
        for (const o of overrides) out(`  override: ${describeOverride(o)}`);
        if (replay) out(replayLine(replay, branch));
        else out(`run \`shadow replay ${branch.id}\` to execute the counterfactual`);
      },
    );

  program
    .command("replay")
    .description("execute the deterministic replay of a forked branch")
    .argument("<branchId>", "branch id")
    .option("--json", "print JSON")
    .action(async (branchId: string, opts: { json?: boolean }) => {
      const result = await client().post<{ replay: Replay; branch: Branch }>(
        `/api/v1/branches/${encodeURIComponent(branchId)}/replay`,
        { mode: "deterministic" },
      );
      if (opts.json) return json(result);
      out(replayLine(result.replay, result.branch));
      if (result.replay.status === "failed")
        throw new CliError(result.replay.error ?? "replay failed", EXIT.error);
    });

  program
    .command("compare")
    .description("compare two branches of a trace")
    .argument("<baseBranchId>", "original branch")
    .argument("<targetBranchId>", "counterfactual branch")
    .option("--json", "print JSON")
    .action(async (baseBranchId: string, targetBranchId: string, opts: { json?: boolean }) => {
      const comparison = await client().post<Comparison>("/api/v1/comparisons", {
        baseBranchId,
        targetBranchId,
      });
      if (opts.json) return json(comparison);
      const r = comparison.result;
      out(`${r.base.name} (original)  vs  ${r.target.name} (counterfactual)`);
      out("");
      out(
        table(
          ["METRIC", "ORIGINAL", "COUNTERFACTUAL", "DELTA"],
          [
            [
              "outcome",
              r.outcome.base?.label ?? "-",
              r.outcome.target?.label ?? "-",
              r.outcome.changed ? "changed" : "same",
            ],
            [
              "est. cost",
              money(r.metrics.totalEstimatedCost.base),
              money(r.metrics.totalEstimatedCost.target),
              percent(r.metrics.totalEstimatedCost.percent),
            ],
            [
              "latency",
              duration(r.metrics.durationMs.base),
              duration(r.metrics.durationMs.target),
              percent(r.metrics.durationMs.percent),
            ],
            [
              "tokens",
              String(r.metrics.totalTokens.base),
              String(r.metrics.totalTokens.target),
              percent(r.metrics.totalTokens.percent),
            ],
            [
              "tool calls",
              String(r.metrics.toolCalls.base),
              String(r.metrics.toolCalls.target),
              String(r.metrics.toolCalls.delta),
            ],
            [
              "model calls",
              String(r.metrics.modelCalls.base),
              String(r.metrics.modelCalls.target),
              String(r.metrics.modelCalls.delta),
            ],
            [
              "policy",
              policyCounts(r.policy.base),
              policyCounts(r.policy.target),
              r.policy.changed ? "changed" : "same",
            ],
          ],
        ),
      );
      out("");
      if (r.firstDivergence) {
        out(
          `first divergence at sequence ${r.firstDivergence.sequence}: ${r.firstDivergence.summary}`,
        );
        for (const f of r.firstDivergence.fields.slice(0, 8)) {
          out(`  ${f.path}: ${JSON.stringify(f.before)} -> ${JSON.stringify(f.after)}`);
        }
      } else {
        out("no divergence: both branches executed identically");
      }
      out(
        `added ${r.addedEvents.length}, removed ${r.removedEvents.length}, modified ${r.modifiedEvents.length} events; comparison id ${comparison.id}`,
      );
    });

  try {
    await program.parseAsync(argv, { from: "user" });
    return EXIT.ok;
  } catch (error) {
    if (error instanceof CommanderError) {
      if (
        error.code === "commander.helpDisplayed" ||
        error.code === "commander.version" ||
        error.code === "commander.help"
      )
        return EXIT.ok;
      return EXIT.usage;
    }
    if (error instanceof CliError) {
      err(`error: ${error.message}`);
      return error.exitCode;
    }
    err(`error: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT.error;
  }
}

async function allEvents(
  api: ApiClient,
  traceId: string,
  branchId: string,
): Promise<ShadowEvent[]> {
  const events: ShadowEvent[] = [];
  let cursor: string | undefined;
  do {
    const page = await api.get<Page<ShadowEvent>>(
      `/api/v1/traces/${encodeURIComponent(traceId)}/events`,
      { branchId, cursor, limit: 1000 },
    );
    events.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return events;
}

function positiveInt(value: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n <= 0) throw new InvalidArgumentError("expected a positive integer");
  return n;
}

function describeEvent(e: ShadowEvent): string {
  const parts: string[] = [];
  if (e.durationMs != null) parts.push(duration(e.durationMs));
  if (e.tokenUsage) parts.push(`${e.tokenUsage.totalTokens} tok`);
  if (e.estimatedCost) parts.push(money(e.estimatedCost.amount, e.estimatedCost.currency));
  if (
    e.eventType === "policy.evaluated" &&
    e.output &&
    typeof e.output === "object" &&
    !Array.isArray(e.output)
  ) {
    parts.push(String((e.output as { decision?: unknown }).decision ?? ""));
  }
  if (e.severity === "error" || e.severity === "warn") parts.push(e.severity.toUpperCase());
  return parts.join(" ");
}

function describeOverride(o: Override): string {
  switch (o.kind) {
    case "context":
      return o.op === "set"
        ? `context ${o.key} = ${JSON.stringify(o.value)}`
        : `remove context ${o.key}`;
    case "state":
      return o.op === "set"
        ? `state ${o.path} = ${JSON.stringify(o.value)}`
        : `remove state ${o.path}`;
    case "tool_result":
      return `tool ${o.tool} (#${o.occurrence}) returns ${JSON.stringify(o.result)}`;
    case "tool_error":
      return `tool ${o.tool} (#${o.occurrence}) fails: ${o.error.message}`;
    case "policy":
      return `policy ${o.policy} config ${JSON.stringify(o.config)}`;
  }
}

function replayLine(replay: Replay, branch: Branch): string {
  return replay.status === "completed"
    ? `replay ${replay.id} completed: ${replay.eventCount} events, outcome "${branch.outcome?.label ?? "-"}", est. cost ${money(branch.metrics.totalEstimatedCost)}, duration ${duration(branch.metrics.durationMs)}`
    : `replay ${replay.id} failed: ${replay.error ?? "unknown error"}`;
}

function policyCounts(c: { allow: number; deny: number; approval_required: number }): string {
  return `${c.allow} allow / ${c.deny} deny / ${c.approval_required} approval`;
}
