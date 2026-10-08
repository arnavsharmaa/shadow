import { mkdir, readFile, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import path from "node:path";
import { buildEventTree, flattenTree } from "@shadow/core";
import type {
  AlertRule,
  ApiKey,
  Artifact,
  AuditEntry,
  BatchJob,
  TraceShare,
  Branch,
  Collection,
  DiffEntry,
  Comparison,
  Fork,
  Override,
  Replay,
  SavedView,
  ShadowEvent,
  TraceExport,
  TraceSummary,
} from "@shadow/schemas";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { ApiClient, CliError, EXIT } from "./client.js";
import {
  duration,
  money,
  parseAssignment,
  parseCutoff,
  percent,
  table,
  truncate,
} from "./format.js";

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
    .option(
      "--token <token>",
      "bearer token for APIs started with SHADOW_API_TOKEN",
      env.SHADOW_TOKEN,
    )
    .option(
      "--actor <name>",
      "name recorded in the audit log for changes you make (default: SHADOW_ACTOR or your OS user)",
      env.SHADOW_ACTOR ?? defaultActor(),
    )
    .exitOverride()
    .configureOutput({ writeOut: (s) => out(s.trimEnd()), writeErr: (s) => err(s.trimEnd()) })
    .showHelpAfterError("(use --help for usage)");

  const client = () => {
    const opts = program.opts<{ endpoint: string; token?: string; actor?: string }>();
    return new ApiClient({
      endpoint: opts.endpoint,
      fetch: options.fetch,
      token: opts.token,
      actor: opts.actor,
    });
  };
  const json = (value: unknown) => out(JSON.stringify(value, null, 2));

  const printComparison = (comparison: Comparison) => {
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
  };

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
        agents?: { replayable: string[] };
        features?: {
          auth: boolean;
          retention: { enabled: boolean; days?: number; intervalMinutes?: number };
          sampling?: { enabled: boolean; rate: number };
          otlp: {
            path: string;
            defaultProject: string;
            export?: { enabled: boolean; encoding?: string };
          };
          webhook?: { enabled: boolean; events?: string; format?: string };
          fileExport?: { enabled: boolean; dir?: string };
        };
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
        replayable: health.agents?.replayable ?? [],
        features: health.features,
      };
      if (opts.json) {
        json(summary);
      } else {
        out(
          `shadow api ${summary.version} at ${summary.endpoint}: ${summary.status} (up ${duration(summary.uptimeSeconds * 1000)})`,
        );
        out(
          `  database  ${summary.database.kind} ${summary.database.location} (${summary.database.healthy ? "healthy" : "unhealthy"})`,
        );
        out(
          `  traces    ${summary.traces} across ${summary.projects} project(s) and ${summary.agents} agent(s); ${summary.tools} distinct tool(s)`,
        );
        out(
          `  replay    ${summary.replayable.length > 0 ? summary.replayable.join(", ") : "no replayable agents registered"}`,
        );
        if (summary.features) {
          const retention = summary.features.retention.enabled
            ? `retention ${summary.features.retention.days}d every ${summary.features.retention.intervalMinutes}m`
            : "retention off";
          const webhook = summary.features.webhook?.enabled
            ? `webhook on (${summary.features.webhook.events ?? "failures"}, ${summary.features.webhook.format ?? "json"})`
            : "webhook off";
          const fileExport = summary.features.fileExport?.enabled
            ? `; file export to ${summary.features.fileExport.dir ?? "?"}`
            : "";
          out(
            `  features  auth ${summary.features.auth ? "required" : "off"}; ${retention}; ${summary.features.sampling?.enabled ? `sampling ${Math.round(summary.features.sampling.rate * 100)}% of traces` : "sampling off"}; otlp at ${summary.features.otlp.path}${summary.features.otlp.export?.enabled ? `; otlp export on (${summary.features.otlp.export.encoding ?? "protobuf"})` : ""}; ${webhook}${fileExport}`,
          );
        }
      }
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
    .option("--from <cutoff>", "started at or after (ISO timestamp or age such as 7d)", cutoff)
    .option("--to <cutoff>", "started at or before (ISO timestamp or age such as 1h)", cutoff)
    .option("--min-cost <amount>", "estimated cost at least this much", nonNegative)
    .option("--min-duration <ms>", "duration at least this many milliseconds", nonNegative)
    .option(
      "--sort <field>",
      "startedAt | durationMs | totalEstimatedCost | totalTokens | name",
      (value: string) => {
        const fields = ["startedAt", "durationMs", "totalEstimatedCost", "totalTokens", "name"];
        if (!fields.includes(value))
          throw new InvalidArgumentError(`expected one of ${fields.join(", ")}`);
        return value;
      },
    )
    .option("--order <direction>", "asc | desc", (value: string) => {
      if (value !== "asc" && value !== "desc")
        throw new InvalidArgumentError("expected asc or desc");
      return value;
    })
    .option("--limit <n>", "maximum rows", positiveInt, 25)
    .option("--view <name>", "start from a shared saved view; explicit options override it")
    .option("--collection <name>", "only traces in this collection")
    .option("--json", "print JSON instead of a table")
    .action(
      async (opts: {
        view?: string;
        collection?: string;
        project?: string;
        agent?: string;
        status?: string;
        tag?: string;
        tool?: string;
        query?: string;
        from?: string;
        to?: string;
        minCost?: number;
        minDuration?: number;
        sort?: string;
        order?: string;
        limit: number;
        json?: boolean;
      }) => {
        const api = client();
        const base: Record<string, string> = {};
        if (opts.view) {
          const found = await api.get<{ items: SavedView[] }>("/api/v1/views", {
            name: opts.view,
          });
          for (const [key, value] of new URLSearchParams(found.items[0]?.query ?? "")) {
            base[key] = value;
          }
        }
        const explicit: Record<string, string | number | undefined> = {
          project: opts.project,
          agent: opts.agent,
          status: opts.status,
          tag: opts.tag,
          tool: opts.tool,
          q: opts.query,
          from: opts.from,
          to: opts.to,
          minCost: opts.minCost,
          minDurationMs: opts.minDuration,
          collection: opts.collection,
          sort: opts.sort,
          order: opts.order,
        };
        const query: Record<string, string | number | undefined> = { ...base };
        for (const [key, value] of Object.entries(explicit)) {
          if (value !== undefined) query[key] = value;
        }
        const page = await api.get<Page<TraceSummary>>("/api/v1/traces", {
          ...query,
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
    .option("--grep <text>", "only events whose name or type contains this text")
    .option("--type <eventType>", "only events of this type, e.g. tool.request")
    .option("--severity <level>", "debug | info | warn | error")
    .option("--json", "print JSON instead of text")
    .action(
      async (
        traceId: string,
        opts: {
          branch?: string;
          grep?: string;
          type?: string;
          severity?: string;
          json?: boolean;
        },
      ) => {
        const api = client();
        const detail = await api.get<{ trace: TraceSummary; branches: Branch[] }>(
          `/api/v1/traces/${encodeURIComponent(traceId)}`,
        );
        const branchId = opts.branch ?? detail.trace.rootBranchId;
        const events = await allEvents(api, traceId, branchId, {
          q: opts.grep,
          eventType: opts.type,
          severity: opts.severity,
        });
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
        const filtered = Boolean(opts.grep || opts.type || opts.severity);
        out(`events (branch ${branchId}${filtered ? `, ${events.length} matching` : ""})`);
        // A filtered list is not a complete hierarchy, so print it flat.
        const nodes = filtered
          ? events.map((event) => ({ event, depth: 0 }))
          : flattenTree(buildEventTree(events));
        for (const node of nodes) {
          const e = node.event;
          const indent = "  ".repeat(node.depth);
          const extra = describeEvent(e);
          out(
            `${String(e.sequence).padStart(4)}  ${indent}${e.eventType.padEnd(26)} ${e.name}${extra ? `  ${extra}` : ""}`,
          );
        }
      },
    );

  traces
    .command("update")
    .description("rename a trace or edit its tags and metadata")
    .argument("<traceId>", "trace id")
    .option("--name <name>", "new trace name")
    .option("--tag <tag...>", "add tags")
    .option("--untag <tag...>", "remove tags")
    .option("--tags <tag...>", "replace the whole tag list")
    .option("--meta <key=value...>", "set metadata keys (JSON values allowed)")
    .option("--unset-meta <key...>", "remove metadata keys")
    .option("--json", "print JSON")
    .action(
      async (
        traceId: string,
        opts: {
          name?: string;
          tag?: string[];
          untag?: string[];
          tags?: string[];
          meta?: string[];
          unsetMeta?: string[];
          json?: boolean;
        },
      ) => {
        const metadata: Record<string, unknown> = {};
        for (const item of opts.meta ?? []) {
          const { key, value } = parseAssignment(item);
          if (value === null)
            throw new CliError(`--meta ${key}: use --unset-meta to remove a key`, EXIT.usage);
          metadata[key] = value;
        }
        for (const key of opts.unsetMeta ?? []) metadata[key] = null;
        const body: Record<string, unknown> = {};
        if (opts.name !== undefined) body.name = opts.name;
        if (opts.tags) body.tags = opts.tags;
        if (opts.tag) body.addTags = opts.tag;
        if (opts.untag) body.removeTags = opts.untag;
        if (Object.keys(metadata).length > 0) body.metadata = metadata;
        if (Object.keys(body).length === 0) {
          throw new CliError(
            "nothing to update: pass --name, --tag, --untag, --tags, --meta or --unset-meta",
            EXIT.usage,
          );
        }
        const updated = await client().patch<TraceSummary>(
          `/api/v1/traces/${encodeURIComponent(traceId)}`,
          body,
        );
        if (opts.json) return json(updated);
        out(`updated ${updated.id}`);
        out(`  name      ${updated.name}`);
        out(`  tags      ${updated.tags.join(", ") || "-"}`);
        const keys = Object.keys(updated.metadata);
        out(`  metadata  ${keys.length > 0 ? keys.join(", ") : "-"}`);
      },
    );

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
    .description("import a previously exported trace bundle, from a file or a share link")
    .argument("<file>", "path to a .json bundle, or a share URL (…/api/v1/shared/shs_…)")
    .option("--regenerate-ids", "assign fresh ids (import a copy)")
    .action(async (file: string, opts: { regenerateIds?: boolean }) => {
      let raw: unknown;
      try {
        if (/^https?:\/\//i.test(file)) {
          // Share links are capability URLs: fetched without this API's token.
          const response = await (options.fetch ?? globalThis.fetch)(file, {
            headers: { accept: "application/json" },
          });
          if (!response.ok) {
            throw new CliError(
              `the share link answered ${response.status}${response.status === 404 ? " (expired, revoked or unknown)" : ""}`,
              response.status === 404 ? EXIT.notFound : EXIT.error,
            );
          }
          raw = await response.json();
        } else {
          raw = JSON.parse(await readFile(file, "utf8"));
        }
      } catch (error) {
        if (error instanceof CliError) throw error;
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

  traces
    .command("share")
    .description("create a read-only link that serves the trace bundle without the API token")
    .argument("<traceId>", "trace id")
    .option("--expires <age>", "lifetime such as 12h, 7d or 30d (max 30d)", "7d")
    .option("--note <text>", "who or what the link is for")
    .option(
      "--web <url>",
      "web app base URL for the viewer link",
      env.SHADOW_WEB_URL ?? "http://localhost:3000",
    )
    .option("--json", "print JSON")
    .action(
      async (
        traceId: string,
        opts: { expires: string; note?: string; web: string; json?: boolean },
      ) => {
        const hours = durationHours(opts.expires);
        const endpoint = program.opts<{ endpoint: string }>().endpoint.replace(/\/+$/, "");
        const created = await client().post<{ share: TraceShare; token: string; path: string }>(
          `/api/v1/traces/${encodeURIComponent(traceId)}/shares`,
          { expiresInHours: hours, ...(opts.note ? { note: opts.note } : {}) },
        );
        const url = `${endpoint}${created.path}`;
        const viewer = `${opts.web.replace(/\/+$/, "")}/shared/${created.token}`;
        if (opts.json) return json({ ...created, url, viewer });
        out(url);
        out(`view it in the browser: ${viewer}`);
        out(
          `share ${created.share.id} expires ${created.share.expiresAt}; anyone with the link can read the whole trace. Revoke with: shadow traces unshare ${traceId} ${created.share.id}`,
        );
      },
    );

  traces
    .command("shares")
    .description("list a trace's share links (tokens are never shown again)")
    .argument("<traceId>", "trace id")
    .option("--json", "print JSON instead of a table")
    .action(async (traceId: string, opts: { json?: boolean }) => {
      const page = await client().get<{ items: TraceShare[] }>(
        `/api/v1/traces/${encodeURIComponent(traceId)}/shares`,
      );
      if (opts.json) return json(page);
      if (page.items.length === 0) return out("no share links");
      out(
        table(
          ["SHARE", "STATE", "EXPIRES", "OPENED", "NOTE"],
          page.items.map((s) => [
            s.id,
            s.revokedAt ? "revoked" : Date.parse(s.expiresAt) <= Date.now() ? "expired" : "active",
            s.expiresAt,
            `${s.accessCount}x${s.lastAccessedAt ? ` (last ${s.lastAccessedAt})` : ""}`,
            s.note ?? "",
          ]),
        ),
      );
    });

  traces
    .command("unshare")
    .description("revoke a share link")
    .argument("<traceId>", "trace id")
    .argument("<shareId>", "share id from `shadow traces shares`")
    .action(async (traceId: string, shareId: string) => {
      await client().delete(
        `/api/v1/traces/${encodeURIComponent(traceId)}/shares/${encodeURIComponent(shareId)}`,
      );
      out(`revoked ${shareId}`);
    });

  traces
    .command("delete")
    .description("delete one or more traces with all their branches")
    .argument("<traceId...>", "trace ids")
    .option("--yes", "confirm the deletion")
    .action(async (traceIds: string[], opts: { yes?: boolean }) => {
      if (!opts.yes) {
        throw new CliError(
          `refusing to delete ${traceIds.length} trace(s) without --yes`,
          EXIT.usage,
        );
      }
      const api = client();
      const failures: string[] = [];
      for (const traceId of traceIds) {
        try {
          await api.delete(`/api/v1/traces/${encodeURIComponent(traceId)}`);
          out(`deleted ${traceId}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          err(`${traceId}: ${message}`);
          failures.push(traceId);
        }
      }
      if (failures.length > 0) {
        throw new CliError(
          `${failures.length} of ${traceIds.length} trace(s) could not be deleted`,
          failures.length === traceIds.length && traceIds.length === 1 ? EXIT.notFound : EXIT.error,
        );
      }
    });

  traces
    .command("prune")
    .description("delete traces that started before a cutoff (retention)")
    .requiredOption(
      "--before <cutoff>",
      "ISO timestamp or relative age such as 30d, 12h, 2w",
      cutoff,
    )
    .option("--project <slug>", "only this project")
    .option("--agent <slug>", "only this agent")
    .option("--status <status>", "running | completed | failed")
    .option("--tag <tag>", "only traces carrying this tag")
    .option(
      "--exclude-tag <tag>",
      'never delete traces carrying this tag (pass "" to include them)',
      "keep",
    )
    .option("--limit <n>", "maximum traces to delete per run", positiveInt, 1000)
    .option("--dry-run", "list what would be deleted without deleting")
    .option(
      "--archive <dir>",
      "export each trace to <dir>/<traceId>.shadow.json before deleting it",
    )
    .option("--yes", "confirm the deletion (required unless --dry-run)")
    .option("--json", "print JSON")
    .action(
      async (opts: {
        before: string;
        project?: string;
        agent?: string;
        status?: string;
        tag?: string;
        excludeTag: string;
        limit: number;
        dryRun?: boolean;
        archive?: string;
        yes?: boolean;
        json?: boolean;
      }) => {
        if (!opts.dryRun && !opts.yes) {
          throw new CliError(
            "refusing to delete without --yes; run with --dry-run first to preview",
            EXIT.usage,
          );
        }
        const api = client();
        const body = {
          before: opts.before,
          project: opts.project,
          agent: opts.agent,
          status: opts.status,
          tag: opts.tag,
          ...(opts.excludeTag ? { excludeTag: opts.excludeTag } : {}),
          limit: opts.limit,
        };
        type PruneResult = {
          dryRun: boolean;
          matched: number;
          traceIds: string[];
          truncated: boolean;
        };
        let result: PruneResult;
        const archived: string[] = [];
        if (opts.archive && !opts.dryRun) {
          // Archive first, then delete one by one: a trace is only removed once its
          // bundle is safely on disk.
          const preview = await api.post<PruneResult>("/api/v1/traces/prune", {
            ...body,
            dryRun: true,
          });
          await mkdir(opts.archive, { recursive: true });
          const deleted: string[] = [];
          for (const traceId of preview.traceIds) {
            const bundle = await api.get<TraceExport>(
              `/api/v1/traces/${encodeURIComponent(traceId)}/export`,
            );
            const file = path.join(opts.archive, `${traceId}.shadow.json`);
            await writeFile(file, JSON.stringify(bundle, null, 2), "utf8");
            archived.push(file);
            await api.delete(`/api/v1/traces/${encodeURIComponent(traceId)}`);
            deleted.push(traceId);
          }
          result = {
            dryRun: false,
            matched: deleted.length,
            traceIds: deleted,
            truncated: preview.truncated,
          };
        } else {
          result = await api.post<PruneResult>("/api/v1/traces/prune", {
            ...body,
            dryRun: Boolean(opts.dryRun),
          });
        }
        if (opts.json) return json({ ...result, archived });
        const verb = result.dryRun ? "would delete" : "deleted";
        out(`${verb} ${result.matched} trace(s) started before ${opts.before}`);
        for (const id of result.traceIds) out(`  ${id}`);
        if (archived.length > 0) out(`archived ${archived.length} bundle(s) to ${opts.archive}`);
        if (result.truncated) {
          out(
            `more traces match; run again${result.dryRun ? "" : " to continue"} or raise --limit`,
          );
        }
      },
    );

  const keys = program
    .command("keys")
    .description(
      "API keys with ingest, read or admin scope (needs SHADOW_API_TOKEN or an admin key)",
    );

  keys
    .command("list")
    .description("list API keys (secrets are never shown again)")
    .option("--json", "print JSON instead of a table")
    .action(async (opts: { json?: boolean }) => {
      const page = await client().get<{ items: ApiKey[] }>("/api/v1/keys");
      if (opts.json) return json(page);
      if (page.items.length === 0) return out("no API keys");
      out(
        table(
          ["KEY", "NAME", "SCOPE", "PROJECT", "PREFIX", "STATE", "LAST USED", "CREATED"],
          page.items.map((k) => [
            k.id,
            k.name,
            k.scope,
            k.project ?? "any",
            `${k.prefix}…`,
            k.revokedAt ? `revoked ${k.revokedAt}` : "active",
            k.lastUsedAt ?? "never",
            k.createdAt,
          ]),
        ),
      );
    });

  keys
    .command("create")
    .description("create an API key; the secret is printed once")
    .argument("<name>", "key name, e.g. ci-ingest")
    .option(
      "--scope <scope>",
      "ingest | read | admin",
      (value: string) => {
        if (!["ingest", "read", "admin"].includes(value)) {
          throw new InvalidArgumentError("expected ingest, read or admin");
        }
        return value;
      },
      "ingest",
    )
    .option("--project <slug>", "pin an ingest or read key to one project")
    .option("--json", "print JSON")
    .action(async (name: string, opts: { scope: string; project?: string; json?: boolean }) => {
      const result = await client().post<{ key: ApiKey; secret: string }>("/api/v1/keys", {
        name,
        scope: opts.scope,
        ...(opts.project ? { project: opts.project } : {}),
      });
      if (opts.json) return json(result);
      out(result.secret);
      out(
        `created ${result.key.id} (${result.key.name}, scope ${result.key.scope}${result.key.project ? `, project ${result.key.project}` : ""}). Store the secret now: it cannot be shown again. Use it as --token or SHADOW_TOKEN.`,
      );
    });

  keys
    .command("revoke")
    .description("revoke an API key by name or id")
    .argument("<nameOrId>", "key name or id")
    .action(async (nameOrId: string) => {
      const key = await client().delete<ApiKey>(`/api/v1/keys/${encodeURIComponent(nameOrId)}`);
      out(`revoked ${key.name} (${key.id})`);
    });

  program
    .command("pricing")
    .description("show the model price table the API uses to estimate costs")
    .option("--provider <name>", "only this provider")
    .option("--json", "print JSON")
    .action(async (opts: { provider?: string; json?: boolean }) => {
      const pricing = await client().get<{
        version: string;
        items: {
          provider: string;
          model: string;
          inputPerMillion: number;
          outputPerMillion: number;
          cachedInputPerMillion?: number;
          currency: string;
          version: string;
        }[];
      }>("/api/v1/pricing");
      const items = opts.provider
        ? pricing.items.filter((p) => p.provider === opts.provider)
        : pricing.items;
      if (opts.json) return json({ ...pricing, items });
      if (items.length === 0) return out("no prices");
      out(
        table(
          ["PROVIDER", "MODEL", "INPUT / M", "OUTPUT / M", "CACHED / M", "CURRENCY", "VERSION"],
          items.map((p) => [
            p.provider,
            p.model,
            String(p.inputPerMillion),
            String(p.outputPerMillion),
            p.cachedInputPerMillion === undefined ? "-" : String(p.cachedInputPerMillion),
            p.currency,
            p.version,
          ]),
        ),
      );
      out(
        `${items.length} model(s); prices are estimates, not invoices (table ${pricing.version})`,
      );
    });

  const collections = program
    .command("collections")
    .description("named groups of traces: incidents, experiments, review queues");

  collections
    .command("list")
    .description("list collections")
    .option("--trace <traceId>", "only collections containing this trace")
    .option("--json", "print JSON instead of a table")
    .action(async (opts: { trace?: string; json?: boolean }) => {
      const page = await client().get<{ items: Collection[] }>("/api/v1/collections", {
        traceId: opts.trace,
      });
      if (opts.json) return json(page);
      if (page.items.length === 0) return out("no collections");
      out(
        table(
          ["COLLECTION", "NAME", "TRACES", "UPDATED", "DESCRIPTION"],
          page.items.map((c) => [
            c.id,
            c.name,
            String(c.traceCount),
            c.updatedAt,
            truncate(c.description ?? "", 50),
          ]),
        ),
      );
    });

  collections
    .command("create")
    .description("create a collection, optionally with traces")
    .argument("<name>", "collection name")
    .argument("[traceId...]", "traces to add")
    .option("--description <text>", "what the collection is for")
    .option("--json", "print JSON")
    .action(
      async (name: string, traceIds: string[], opts: { description?: string; json?: boolean }) => {
        const result = await client().post<CollectionChange>("/api/v1/collections", {
          name,
          traceIds,
          ...(opts.description ? { description: opts.description } : {}),
        });
        if (opts.json) return json(result);
        out(
          `created ${result.collection.name} (${result.collection.id}) with ${result.collection.traceCount} trace(s)`,
        );
        if (result.missing.length > 0) out(`not found: ${result.missing.join(", ")}`);
      },
    );

  collections
    .command("add")
    .description("add traces to a collection")
    .argument("<collection>", "collection name or id")
    .argument("<traceId...>", "trace ids")
    .action(async (collection: string, traceIds: string[]) => {
      const result = await client().post<CollectionChange>(
        `/api/v1/collections/${encodeURIComponent(collection)}/traces`,
        { traceIds },
      );
      out(
        `added ${result.added.length} trace(s) to ${result.collection.name}; it now holds ${result.collection.traceCount}`,
      );
      if (result.missing.length > 0) out(`not found: ${result.missing.join(", ")}`);
    });

  collections
    .command("remove")
    .description("remove traces from a collection (the traces themselves are kept)")
    .argument("<collection>", "collection name or id")
    .argument("<traceId...>", "trace ids")
    .action(async (collection: string, traceIds: string[]) => {
      const api = client();
      for (const traceId of traceIds) {
        await api.delete(
          `/api/v1/collections/${encodeURIComponent(collection)}/traces/${encodeURIComponent(traceId)}`,
        );
      }
      out(`removed ${traceIds.length} trace(s) from ${collection}`);
    });

  collections
    .command("delete")
    .description("delete a collection (its traces are kept)")
    .argument("<collection>", "collection name or id")
    .action(async (collection: string) => {
      await client().delete(`/api/v1/collections/${encodeURIComponent(collection)}`);
      out(`deleted collection ${collection}`);
    });

  const alerts = program
    .command("alerts")
    .description(
      "threshold alerts on failure rate, policy violations, tool errors, cost and latency",
    );

  alerts
    .command("list")
    .description("list alert rules with their current state")
    .option("--json", "print JSON instead of a table")
    .action(async (opts: { json?: boolean }) => {
      const page = await client().get<{ items: AlertRule[] }>("/api/v1/alerts/rules");
      if (opts.json) return json(page);
      if (page.items.length === 0) return out("no alert rules");
      out(alertTable(page.items));
    });

  alerts
    .command("add")
    .description("create an alert rule; it fires while the metric is at or above the threshold")
    .argument("<name>", "rule name")
    .requiredOption(
      "--metric <metric>",
      "failure_rate | policy_violations | tool_errors | total_cost | p95_duration_ms",
    )
    .requiredOption(
      "--threshold <n>",
      "fire at or above this value; with --baseline, at or above this multiple of the baseline",
      nonNegative,
    )
    .option(
      "--baseline",
      "compare against the metric's own recent baseline instead of a fixed value",
    )
    .option(
      "--baseline-windows <n>",
      "how many preceding windows form the baseline",
      positiveInt,
      7,
    )
    .option("--agent <slug>", "only this agent's traces")
    .option("--project <slug>", "only this project's traces")
    .option("--window <age>", "look-back window such as 30m, 6h or 7d", "1h")
    .option("--min-traces <n>", "traces needed in the window before it can fire", positiveInt, 1)
    .option("--json", "print JSON")
    .action(
      async (
        name: string,
        opts: {
          metric: string;
          threshold: number;
          baseline?: boolean;
          baselineWindows: number;
          agent?: string;
          project?: string;
          window: string;
          minTraces: number;
          json?: boolean;
        },
      ) => {
        const rule = await client().post<AlertRule>("/api/v1/alerts/rules", {
          name,
          metric: opts.metric,
          threshold: opts.threshold,
          ...(opts.baseline ? { mode: "baseline", baselineWindows: opts.baselineWindows } : {}),
          agent: opts.agent,
          project: opts.project,
          windowMinutes: windowMinutes(opts.window),
          minTraces: opts.minTraces,
        });
        if (opts.json) return json(rule);
        out(
          rule.mode === "baseline"
            ? `created ${rule.id}: ${rule.name} fires when ${rule.metric} over ${rule.windowMinutes}m >= ${rule.threshold}x its baseline (previous ${rule.baselineWindows} windows)`
            : `created ${rule.id}: ${rule.name} fires when ${rule.metric} >= ${rule.threshold} over ${rule.windowMinutes}m`,
        );
      },
    );

  alerts
    .command("remove")
    .description("delete an alert rule by name or id")
    .argument("<nameOrId>", "rule name or id")
    .action(async (nameOrId: string) => {
      const api = client();
      let id = nameOrId;
      if (!nameOrId.startsWith("alr_")) {
        const page = await api.get<{ items: AlertRule[] }>("/api/v1/alerts/rules");
        const match = page.items.find((r) => r.name === nameOrId);
        if (!match) throw new CliError(`no alert rule named '${nameOrId}'`, EXIT.notFound);
        id = match.id;
      }
      await api.delete(`/api/v1/alerts/rules/${encodeURIComponent(id)}`);
      out(`deleted alert rule ${nameOrId}`);
    });

  alerts
    .command("check")
    .description("evaluate every rule now; exits 1 when any rule is firing (useful in CI)")
    .option("--json", "print JSON")
    .action(async (opts: { json?: boolean }) => {
      const result = await client().post<{
        items: { rule: AlertRule; transition: "fired" | "resolved" | "none" }[];
      }>("/api/v1/alerts/evaluate", {});
      const firing = result.items.filter((e) => e.rule.state === "firing");
      if (opts.json) json(result);
      else if (result.items.length === 0) out("no enabled alert rules");
      else {
        out(alertTable(result.items.map((e) => e.rule)));
        out(`${firing.length} of ${result.items.length} rule(s) firing`);
      }
      if (firing.length > 0) {
        throw new CliError(`firing: ${firing.map((e) => e.rule.name).join(", ")}`, EXIT.error);
      }
    });

  program
    .command("trend")
    .description("one agent's traces, failures, latency or cost per day or hour (UTC)")
    .argument("<agent>", "agent slug")
    .option("--project <slug>", "only this project")
    .option(
      "--bucket <bucket>",
      "day | hour",
      (value: string) => {
        if (value !== "day" && value !== "hour")
          throw new InvalidArgumentError("expected day or hour");
        return value;
      },
      "day",
    )
    .option(
      "--metric <metric>",
      "traces | failed | policyViolations | p95DurationMs | totalEstimatedCost | totalTokens",
      (value: string) => {
        if (!TREND_METRIC_KEYS.includes(value as TrendMetricKey)) {
          throw new InvalidArgumentError(`expected one of ${TREND_METRIC_KEYS.join(", ")}`);
        }
        return value;
      },
      "traces",
    )
    .option("--from <cutoff>", "start of the window (ISO timestamp or age such as 7d)", cutoff)
    .option("--to <cutoff>", "end of the window (default: now)", cutoff)
    .option("--json", "print JSON")
    .action(
      async (
        agent: string,
        opts: {
          project?: string;
          bucket: string;
          metric: TrendMetricKey;
          from?: string;
          to?: string;
          json?: boolean;
        },
      ) => {
        const trend = await client().get<CliTrend>(
          `/api/v1/stats/agents/${encodeURIComponent(agent)}/timeseries`,
          { bucket: opts.bucket, project: opts.project, from: opts.from, to: opts.to },
        );
        if (opts.json) return json(trend);
        const values = trend.points.map((p) => p[opts.metric] ?? 0);
        out(`${agent} ${opts.metric} per ${trend.bucket}, ${trend.from} to ${trend.to}`);
        out(sparkline(values));
        const busy = trend.points.filter((p) => p.traces > 0);
        if (busy.length === 0) return out("no traces in this window");
        out(
          table(
            ["BUCKET", opts.metric.toUpperCase(), "TRACES", "FAILED"],
            busy.map((p) => [
              p.start,
              opts.metric === "totalEstimatedCost"
                ? money(p.totalEstimatedCost)
                : opts.metric === "p95DurationMs"
                  ? duration(p.p95DurationMs)
                  : String(p[opts.metric] ?? "-"),
              String(p.traces),
              String(p.failed),
            ]),
          ),
        );
      },
    );

  program
    .command("agents")
    .description("per-agent volume, failures, policy violations, latency, cost and tokens")
    .option("--project <slug>", "only this project")
    .option(
      "--from <cutoff>",
      "traces started at or after (ISO timestamp or age such as 7d)",
      cutoff,
    )
    .option("--to <cutoff>", "traces started at or before", cutoff)
    .option("--json", "print JSON")
    .action(async (opts: { project?: string; from?: string; to?: string; json?: boolean }) => {
      const stats = await client().get<{
        items: {
          agentSlug: string;
          projectSlug: string;
          traces: number;
          failed: number;
          policyViolations: number;
          toolErrors: number;
          avgDurationMs: number | null;
          p95DurationMs: number | null;
          totalEstimatedCost: number;
          totalTokens: number;
          lastStartedAt: string | null;
        }[];
      }>("/api/v1/stats/agents", { project: opts.project, from: opts.from, to: opts.to });
      if (opts.json) return json(stats);
      if (stats.items.length === 0) return out("no traces in range");
      out(
        table(
          [
            "AGENT",
            "PROJECT",
            "TRACES",
            "FAILED",
            "POLICY VIOL.",
            "TOOL ERR",
            "AVG",
            "P95",
            "EST. COST",
            "TOKENS",
            "LAST RUN",
          ],
          stats.items.map((a) => [
            a.agentSlug,
            a.projectSlug,
            String(a.traces),
            String(a.failed),
            String(a.policyViolations),
            String(a.toolErrors),
            duration(a.avgDurationMs),
            duration(a.p95DurationMs),
            money(a.totalEstimatedCost),
            String(a.totalTokens),
            a.lastStartedAt ?? "-",
          ]),
        ),
      );
    });

  const importers = program
    .command("import")
    .description("import conversation logs recorded outside Shadow");

  importers
    .command("anthropic")
    .description("import a stored Anthropic Messages API conversation as a trace")
    .argument(
      "<file>",
      "JSON file: a messages array, or an object with messages plus system, tools, model, responses",
    )
    .option("--project <slug>", "project (default: the file's, or anthropic)")
    .option("--agent <slug>", "agent (default: the file's, or claude-agent)")
    .option("--name <name>", "trace name (default: the first user message)")
    .option("--model <id>", "model id, when the file does not say")
    .option("--tag <tag>", "tag to add (repeatable)", (value: string, previous: string[] = []) => [
      ...previous,
      value,
    ])
    .option("--json", "print JSON")
    .action(
      async (
        file: string,
        opts: {
          project?: string;
          agent?: string;
          name?: string;
          model?: string;
          tag?: string[];
          json?: boolean;
        },
      ) => {
        let raw: unknown;
        try {
          raw = JSON.parse(await readFile(file, "utf8"));
        } catch (error) {
          throw new CliError(
            `could not read ${file}: ${error instanceof Error ? error.message : String(error)}`,
            EXIT.usage,
          );
        }
        const base: Record<string, unknown> = Array.isArray(raw)
          ? { messages: raw }
          : raw !== null && typeof raw === "object"
            ? { ...(raw as Record<string, unknown>) }
            : {};
        if (!Array.isArray(base.messages)) {
          throw new CliError(`${file} has no messages array`, EXIT.usage);
        }
        const fileTags = Array.isArray(base.tags) ? (base.tags as unknown[]) : [];
        const result = await client().post<{
          traceId: string;
          name: string;
          events: number;
          summary: {
            turns: number;
            toolCalls: number;
            serverToolCalls: number;
            unmatchedToolUses: number;
            orphanToolResults: number;
            stopReason: string | null;
          };
        }>("/api/v1/import/anthropic", {
          ...base,
          ...(opts.project ? { project: opts.project } : {}),
          ...(opts.agent ? { agent: opts.agent } : {}),
          ...(opts.name ? { name: opts.name } : {}),
          ...(opts.model ? { model: opts.model } : {}),
          ...(opts.tag ? { tags: [...fileTags, ...opts.tag] } : {}),
        });
        if (opts.json) return json(result);
        const s = result.summary;
        out(
          `imported ${result.traceId}: ${s.turns} turn(s), ${s.toolCalls + s.serverToolCalls} tool call(s), ${result.events} event(s), stop reason ${s.stopReason ?? "none"}`,
        );
        if (s.unmatchedToolUses > 0)
          out(`${s.unmatchedToolUses} tool call(s) have no result in the file`);
        if (s.orphanToolResults > 0)
          out(`${s.orphanToolResults} tool result(s) match no tool call`);
      },
    );

  const otlp = program.command("otlp").description("OpenTelemetry (OTLP) tools");

  otlp
    .command("import")
    .description("send an OTLP/HTTP JSON traces export (for example a collector file export)")
    .argument("<file...>", "OTLP JSON file(s); each line may hold one ExportTraceServiceRequest")
    .option("--json", "print JSON")
    .action(async (files: string[], opts: { json?: boolean }) => {
      const api = client();
      const results: { file: string; traces: unknown[] }[] = [];
      for (const file of files) {
        let raw: string;
        try {
          raw = await readFile(file, "utf8");
        } catch (error) {
          throw new CliError(
            `could not read ${file}: ${error instanceof Error ? error.message : String(error)}`,
            EXIT.usage,
          );
        }
        // Accept a single JSON document or newline-delimited JSON (collector file exporter).
        const documents: unknown[] = [];
        const trimmed = raw.trim();
        try {
          documents.push(JSON.parse(trimmed));
        } catch {
          for (const [index, line] of trimmed.split("\n").entries()) {
            if (!line.trim()) continue;
            try {
              documents.push(JSON.parse(line));
            } catch {
              throw new CliError(`${file}:${index + 1} is not valid JSON`, EXIT.usage);
            }
          }
        }
        for (const document of documents) {
          const result = await api.post<{ shadow: { traces: unknown[] } }>(
            "/api/v1/otlp/v1/traces",
            document,
          );
          results.push({ file, traces: result.shadow.traces });
        }
      }
      if (opts.json) return json(results);
      let created = 0;
      let extended = 0;
      let accepted = 0;
      for (const r of results) {
        for (const t of r.traces as {
          traceId: string;
          created: boolean;
          accepted: number;
          skipped: number;
        }[]) {
          if (t.created) created++;
          else extended++;
          accepted += t.accepted;
          out(
            `${t.created ? "created " : "extended"} ${t.traceId}: ${t.accepted} event(s)${t.skipped ? `, ${t.skipped} already stored` : ""}`,
          );
        }
      }
      out(
        `imported ${results.length} request(s) from ${files.length} file(s): ${created} trace(s) created, ${extended} extended, ${accepted} event(s) stored`,
      );
    });

  otlp
    .command("export")
    .description("export a trace as OTLP (every branch becomes an OpenTelemetry trace)")
    .argument("<traceId>", "trace id")
    .option("-o, --out <file>", "write the payload to a file instead of stdout")
    .option("--protobuf", "use the protobuf encoding (requires --out or --collector)")
    .option(
      "--collector <url>",
      "also POST the payload to an OTLP/HTTP traces endpoint, e.g. http://localhost:4318/v1/traces",
    )
    .option("--header <name:value...>", "extra request header(s) for the collector")
    .action(
      async (
        traceId: string,
        opts: { out?: string; protobuf?: boolean; collector?: string; header?: string[] },
      ) => {
        if (opts.protobuf && !opts.out && !opts.collector) {
          throw new CliError("--protobuf needs --out <file> or --collector <url>", EXIT.usage);
        }
        const api = client();
        const path = `/api/v1/traces/${encodeURIComponent(traceId)}/export`;
        const contentType = opts.protobuf ? "application/x-protobuf" : "application/json";
        let bytes: Uint8Array<ArrayBuffer>;
        let spans = 0;
        if (opts.protobuf) {
          bytes = (await api.download(path, { format: "otlp", encoding: "protobuf" }, contentType))
            .bytes;
        } else {
          const payload = await api.get<{
            resourceSpans?: { scopeSpans?: { spans?: unknown[] }[] }[];
          }>(path, { format: "otlp" });
          for (const r of payload.resourceSpans ?? [])
            for (const s of r.scopeSpans ?? []) spans += s.spans?.length ?? 0;
          bytes = new TextEncoder().encode(JSON.stringify(payload, null, opts.out ? 2 : 0));
        }
        if (opts.out) {
          await writeFile(opts.out, bytes);
          out(
            `wrote ${opts.protobuf ? `${bytes.length} bytes` : `${spans} span(s)`} to ${opts.out}`,
          );
        }
        if (opts.collector) {
          const headers: Record<string, string> = { "content-type": contentType };
          for (const item of opts.header ?? []) {
            const index = item.indexOf(":");
            if (index <= 0)
              throw new CliError(`--header expects name:value, got '${item}'`, EXIT.usage);
            headers[item.slice(0, index).trim()] = item.slice(index + 1).trim();
          }
          let response: Response;
          try {
            response = await (options.fetch ?? globalThis.fetch)(opts.collector, {
              method: "POST",
              headers,
              body: bytes,
            });
          } catch (error) {
            throw new CliError(
              `could not reach the collector at ${opts.collector} (${error instanceof Error ? error.message : String(error)})`,
              EXIT.connection,
            );
          }
          if (!response.ok) {
            throw new CliError(
              `collector rejected the export with status ${response.status}: ${truncate(await response.text(), 300)}`,
              EXIT.error,
            );
          }
          out(
            `sent ${opts.protobuf ? `${bytes.length} bytes` : `${spans} span(s)`} to ${opts.collector}`,
          );
        }
        if (!opts.out && !opts.collector) out(new TextDecoder().decode(bytes));
      },
    );

  const eventsCmd = program.command("events").description("inspect single events");

  eventsCmd
    .command("show")
    .description("print an event with its payloads and the state change it caused")
    .argument("<traceId>", "trace id")
    .argument("<eventId>", "event id")
    .option("--branch <branchId>", "lineage to reconstruct state from (default: the event's)")
    .option("--json", "print JSON")
    .action(async (traceId: string, eventId: string, opts: { branch?: string; json?: boolean }) => {
      const api = client();
      const base = `/api/v1/traces/${encodeURIComponent(traceId)}/events/${encodeURIComponent(eventId)}`;
      const event = await api.get<ShadowEvent>(base);
      const state = await api.get<{
        branchId: string;
        stateDiff: DiffEntry[];
        contextDiff: DiffEntry[];
      }>(`${base}/state`, { branchId: opts.branch });
      if (opts.json) return json({ event, ...state });
      out(`${event.eventType}  ${event.name}`);
      out(`  event     ${event.id}    sequence ${event.sequence}    branch ${event.branchId}`);
      out(
        `  time      ${event.timestamp}${event.durationMs != null ? `    duration ${duration(event.durationMs)}` : ""}`,
      );
      out(`  severity  ${event.severity}    source ${event.source}`);
      if (event.parentEventId) out(`  parent    ${event.parentEventId}`);
      if (event.tokenUsage) {
        out(
          `  tokens    ${event.tokenUsage.inputTokens} in / ${event.tokenUsage.outputTokens} out (${event.tokenUsage.totalTokens} total)`,
        );
      }
      if (event.estimatedCost)
        out(`  est. cost ${money(event.estimatedCost.amount, event.estimatedCost.currency)}`);
      if (event.tags.length > 0) out(`  tags      ${event.tags.join(", ")}`);
      const section = (title: string, value: unknown) => {
        if (value === undefined || value === null) return;
        out("");
        out(title);
        for (const line of JSON.stringify(value, null, 2).split("\n")) out(`  ${line}`);
      };
      section("input", event.input);
      section("output", event.output);
      if (Object.keys(event.metadata).length > 0) section("metadata", event.metadata);
      const diffs = (title: string, entries: DiffEntry[]) => {
        out("");
        out(`${title} (branch ${state.branchId})`);
        if (entries.length === 0) return out("  no change");
        for (const d of entries) {
          out(
            `  ${d.op.padEnd(8)} ${d.path}  ${JSON.stringify(d.before)} -> ${JSON.stringify(d.after)}`,
          );
        }
      };
      diffs("state diff", state.stateDiff);
      diffs("context diff", state.contextDiff);
    });

  program
    .command("audit")
    .description("show the audit log: who forked, replayed, deleted, pruned or imported what")
    .option("--trace <traceId>", "only entries about this trace")
    .option("--action <action>", "e.g. trace.deleted, fork.created, replay.run, traces.pruned")
    .option("--by <actor>", "only entries by this actor")
    .option("--limit <n>", "maximum rows", positiveInt, 50)
    .option("--json", "print JSON instead of a table")
    .action(
      async (opts: {
        trace?: string;
        action?: string;
        by?: string;
        limit: number;
        json?: boolean;
      }) => {
        const page = await client().get<{ items: AuditEntry[]; nextCursor: string | null }>(
          "/api/v1/audit",
          { traceId: opts.trace, action: opts.action, actor: opts.by, limit: opts.limit },
        );
        if (opts.json) return json(page);
        if (page.items.length === 0) return out("no audit entries");
        out(
          table(
            ["AT", "ACTOR", "ACTION", "TARGET", "TRACE", "DETAIL"],
            page.items.map((e) => [
              e.at,
              e.actor,
              e.action,
              `${e.targetType} ${e.targetId}`,
              e.traceId ?? "-",
              truncate(auditDetail(e), 60),
            ]),
          ),
        );
        if (page.nextCursor) out(`(more entries; raise --limit to see them)`);
      },
    );

  const views = program
    .command("views")
    .description("shared saved views: named trace-explorer filters stored on the server");

  views
    .command("list")
    .description("list shared views")
    .option("--json", "print JSON instead of a table")
    .action(async (opts: { json?: boolean }) => {
      const page = await client().get<{ items: SavedView[] }>("/api/v1/views");
      if (opts.json) return json(page);
      if (page.items.length === 0) return out("no shared views");
      out(
        table(
          ["VIEW", "NAME", "FILTERS", "UPDATED"],
          page.items.map((v) => [v.id, v.name, v.query || "(all traces)", v.updatedAt]),
        ),
      );
    });

  views
    .command("save")
    .description("create a shared view, or replace the filters of the view with that name")
    .argument("<name>", "view name")
    .argument(
      "[query]",
      "explorer query string, e.g. 'status=failed&sort=totalEstimatedCost' (default: all traces)",
    )
    .option("--description <text>", "what the view is for")
    .option("--json", "print JSON")
    .action(
      async (
        name: string,
        query: string | undefined,
        opts: { description?: string; json?: boolean },
      ) => {
        const view = await client().post<SavedView>("/api/v1/views", {
          name,
          query: query ?? "",
          ...(opts.description ? { description: opts.description } : {}),
        });
        if (opts.json) return json(view);
        out(`saved view ${view.name} (${view.id}): ${view.query || "(all traces)"}`);
        out(`open it at /?${view.query} or run: shadow traces list --view '${view.name}'`);
      },
    );

  views
    .command("delete")
    .description("delete a shared view by name or id")
    .argument("<nameOrId>", "view name or id")
    .action(async (nameOrId: string) => {
      const api = client();
      let id = nameOrId;
      if (!nameOrId.startsWith("view_")) {
        const found = await api.get<{ items: SavedView[] }>("/api/v1/views", { name: nameOrId });
        id = found.items[0]?.id ?? nameOrId;
      }
      await api.delete(`/api/v1/views/${encodeURIComponent(id)}`);
      out(`deleted view ${nameOrId}`);
    });

  const artifacts = program
    .command("artifacts")
    .description("list and download documents attached to a trace");

  artifacts
    .command("list")
    .description("list artifacts (email bodies, retrieved pages, reports) of a trace")
    .argument("<traceId>", "trace id")
    .option("--branch <branchId>", "only artifacts of this branch")
    .option("--event <eventId>", "only artifacts linked to this event")
    .option("--limit <n>", "maximum rows", positiveInt, 100)
    .option("--json", "print JSON instead of a table")
    .action(
      async (
        traceId: string,
        opts: { branch?: string; event?: string; limit: number; json?: boolean },
      ) => {
        const page = await client().get<{ items: Artifact[] }>(
          `/api/v1/traces/${encodeURIComponent(traceId)}/artifacts`,
          { branchId: opts.branch, eventId: opts.event, limit: opts.limit },
        );
        if (opts.json) return json(page);
        if (page.items.length === 0) return out("no artifacts found");
        out(
          table(
            ["ARTIFACT", "KIND", "NAME", "CONTENT TYPE", "EVENT", "BRANCH", "CREATED"],
            page.items.map((a) => [
              a.id,
              a.kind,
              truncate(a.name, 40),
              a.contentType,
              a.eventId ?? "-",
              a.branchId,
              a.createdAt,
            ]),
          ),
        );
        out(`${page.items.length} artifact(s)`);
      },
    );

  artifacts
    .command("add")
    .description("attach a document or note to a trace, branch or event")
    .argument("<traceId>", "trace id")
    .requiredOption("--kind <kind>", "artifact kind, e.g. note, report, email")
    .option("--name <name>", "artifact name (default: the kind)")
    .option("--event <eventId>", "link to this event")
    .option("--branch <branchId>", "branch (default: root)")
    .option("--content <text>", "inline content (JSON is parsed when valid)")
    .option("--file <path>", "read the content from a file instead")
    .option(
      "--content-type <type>",
      "content type (default: text/plain, or application/json for objects)",
    )
    .option("--json", "print the stored artifact as JSON")
    .action(
      async (
        traceId: string,
        opts: {
          kind: string;
          name?: string;
          event?: string;
          branch?: string;
          content?: string;
          file?: string;
          contentType?: string;
          json?: boolean;
        },
      ) => {
        if ((opts.content === undefined) === (opts.file === undefined)) {
          throw new CliError("pass exactly one of --content or --file", EXIT.usage);
        }
        let raw = opts.content ?? "";
        if (opts.file) {
          try {
            raw = await readFile(opts.file, "utf8");
          } catch (error) {
            throw new CliError(
              `could not read ${opts.file}: ${error instanceof Error ? error.message : String(error)}`,
              EXIT.usage,
            );
          }
        }
        let content: unknown = raw;
        if (/^\s*[[{]/.test(raw)) {
          try {
            content = JSON.parse(raw);
          } catch {
            content = raw;
          }
        }
        const artifact = await client().post<Artifact>(
          `/api/v1/traces/${encodeURIComponent(traceId)}/artifacts`,
          {
            kind: opts.kind,
            name: opts.name ?? opts.kind,
            eventId: opts.event,
            branchId: opts.branch,
            contentType:
              opts.contentType ?? (typeof content === "string" ? "text/plain" : "application/json"),
            content,
          },
        );
        if (opts.json) return json(artifact);
        out(
          `stored ${artifact.kind} ${artifact.id} (${artifact.contentType}) on ${artifact.eventId ? `event ${artifact.eventId}` : `branch ${artifact.branchId}`}`,
        );
      },
    );

  artifacts
    .command("get")
    .description("print an artifact's content, or save it to a file")
    .argument("<traceId>", "trace id")
    .argument("<artifactId>", "artifact id")
    .option("-o, --out <file>", "write the content to a file instead of stdout")
    .option("--json", "print the full artifact record as JSON")
    .action(async (traceId: string, artifactId: string, opts: { out?: string; json?: boolean }) => {
      const artifact = await client().get<Artifact>(
        `/api/v1/traces/${encodeURIComponent(traceId)}/artifacts/${encodeURIComponent(artifactId)}`,
      );
      if (opts.json) return json(artifact);
      const text = artifactText(artifact);
      if (opts.out) {
        await writeFile(opts.out, text, "utf8");
        out(`wrote ${artifact.name} (${artifact.contentType}) to ${opts.out}`);
      } else {
        out(text);
      }
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
    .command("matrix")
    .description(
      "fork one event with a grid of context values, tool results or policy configs, replay and compare every variant",
    )
    .argument("<traceId>", "trace id")
    .requiredOption("--at <eventId>", "event to rewind to")
    .option(
      "--vary <key=v1,v2,...>",
      "context key and comma-separated values; repeat for a grid (max 20 variants)",
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .option(
      "--vary-tool <tool=json>",
      "replace the tool's next result; repeat the same tool to add values to its axis",
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .option(
      "--vary-policy <policy=json>",
      "policy configuration object; repeat the same policy to add values to its axis",
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .option("--branch <branchId>", "parent branch (default: the event's branch)")
    .option("--json", "print JSON")
    .action(
      async (
        traceId: string,
        opts: {
          at: string;
          vary?: string[];
          varyTool?: string[];
          varyPolicy?: string[];
          branch?: string;
          json?: boolean;
        },
      ) => {
        const axes = matrixAxes(opts.vary ?? [], opts.varyTool ?? [], opts.varyPolicy ?? []);
        if (axes.length === 0) {
          throw new CliError(
            "pass at least one of --vary, --vary-tool or --vary-policy",
            EXIT.usage,
          );
        }
        let combos: MatrixCell[][] = [[]];
        for (const axis of axes) {
          combos = combos.flatMap((combo) =>
            axis.values.map((value) => [...combo, { axis, value }]),
          );
        }
        if (combos.length > 20) {
          throw new CliError(`${combos.length} variants requested; the limit is 20`, EXIT.usage);
        }
        const result = await client().post<{
          variants: {
            name: string;
            branch: Branch;
            replay: Replay;
            comparisonId: string;
            outcome: { target: { label: string } | null; changed: boolean };
            firstDivergence: { sequence: number; summary: string } | null;
            deltas: { totalEstimatedCost: number; durationMs: number };
          }[];
        }>(`/api/v1/traces/${encodeURIComponent(traceId)}/forks/matrix`, {
          forkEventId: opts.at,
          parentBranchId: opts.branch,
          variants: combos.map((combo) => ({
            name: truncate(
              combo.map((c) => `${c.axis.name}=${JSON.stringify(c.value)}`).join(" "),
              120,
            ),
            overrides: combo.map((c) => matrixOverride(c)),
          })),
        });
        if (opts.json) return json(result);
        out(
          table(
            [
              "VARIANT",
              "BRANCH",
              "REPLAY",
              "OUTCOME",
              "CHANGED",
              "FIRST DIVERGENCE",
              "COST Δ",
              "COMPARISON",
            ],
            result.variants.map((v) => [
              v.name,
              v.branch.id,
              v.replay.status,
              v.outcome.target?.label ?? "-",
              v.outcome.changed ? "yes" : "no",
              v.firstDivergence
                ? truncate(`#${v.firstDivergence.sequence} ${v.firstDivergence.summary}`, 50)
                : "identical",
              money(v.deltas.totalEstimatedCost),
              v.comparisonId,
            ]),
          ),
        );
        const changed = result.variants.filter((v) => v.outcome.changed).length;
        out(`${result.variants.length} variant(s), ${changed} changed the outcome`);
      },
    );

  program
    .command("batch")
    .description("apply one override set to many recorded traces of an agent and compare each")
    .requiredOption("--agent <slug>", "agent whose traces to re-run")
    .requiredOption(
      "--at <[eventType:]name>",
      "fork each trace at its first matching event, e.g. refund_order or policy.evaluated:refund.limit",
    )
    .option("--project <slug>", "only this project")
    .option("--set <key=value...>", "context override, e.g. --set refundLimit=100")
    .option("--tool-result <tool=json...>", "replace the next result of a tool")
    .option("--policy <policy=json...>", "override a policy's configuration")
    .option("--name <branchName>", "branch name for every fork (default: fork-N)")
    .option("--status <status>", "running | completed | failed")
    .option("--tag <tag>", "only traces carrying this tag")
    .option("--from <cutoff>", "traces started at or after", cutoff)
    .option("--to <cutoff>", "traces started at or before", cutoff)
    .option("--limit <n>", "maximum traces (1-50, or up to 500 with --background)", positiveInt, 20)
    .option("--background", "queue the batch as a job and print its id")
    .option("--wait", "run in the background and poll until the job finishes")
    .option("--interval <ms>", "poll interval for --wait", positiveInt, 2000)
    .option("--json", "print JSON")
    .action(
      async (opts: {
        background?: boolean;
        wait?: boolean;
        interval: number;
        agent: string;
        at: string;
        project?: string;
        set?: string[];
        toolResult?: string[];
        policy?: string[];
        name?: string;
        status?: string;
        tag?: string;
        from?: string;
        to?: string;
        limit: number;
        json?: boolean;
      }) => {
        const overrides: Override[] = [];
        for (const item of opts.set ?? []) {
          const { key, value } = parseAssignment(item);
          overrides.push({ kind: "context", op: "set", key, value: value as never });
        }
        for (const item of opts.toolResult ?? []) {
          const { key, value } = parseAssignment(item);
          overrides.push({ kind: "tool_result", tool: key, occurrence: 1, result: value as never });
        }
        for (const item of opts.policy ?? []) {
          const { key, value } = parseAssignment(item);
          if (value === null || typeof value !== "object" || Array.isArray(value)) {
            throw new CliError(`--policy value for ${key} must be a JSON object`, EXIT.usage);
          }
          overrides.push({ kind: "policy", policy: key, config: value as never });
        }
        if (overrides.length === 0) {
          throw new CliError("pass at least one of --set, --tool-result or --policy", EXIT.usage);
        }
        const separator = opts.at.indexOf(":");
        const at =
          separator > 0 && opts.at.slice(0, separator).includes(".")
            ? { eventType: opts.at.slice(0, separator), name: opts.at.slice(separator + 1) }
            : { eventType: "tool.request", name: opts.at };
        const api = client();
        const background = Boolean(opts.background || opts.wait);
        const request = {
          agent: opts.agent,
          project: opts.project,
          at,
          overrides,
          branchName: opts.name,
          status: opts.status,
          tag: opts.tag,
          from: opts.from,
          to: opts.to,
          limit: opts.limit,
          ...(background ? { background: true } : {}),
        };
        if (!background) {
          const result = await api.post<BatchCliResult>("/api/v1/batch/counterfactuals", request);
          if (opts.json) return json(result);
          return printBatch(result);
        }
        const job = await api.post<BatchJob>("/api/v1/batch/counterfactuals", request);
        if (!opts.wait) {
          if (opts.json) return json(job);
          out(`queued ${job.id}; follow it with: shadow jobs show ${job.id}`);
          return;
        }
        const finished = await waitForJob(api, job.id, opts.interval, opts.json ? null : out);
        if (opts.json) return json(finished);
        if (finished.status === "failed") {
          throw new CliError(`job ${finished.id} failed: ${finished.error ?? "unknown error"}`);
        }
        if (finished.result) printBatch(finished.result as unknown as BatchCliResult);
        if (finished.status === "cancelled") out(`job ${finished.id} was cancelled`);
      },
    );

  const jobs = program.command("jobs").description("background batch jobs");

  jobs
    .command("list")
    .description("list recent background jobs")
    .option("--status <status>", "queued | running | completed | failed | cancelled")
    .option("--limit <n>", "maximum rows", positiveInt, 20)
    .option("--json", "print JSON instead of a table")
    .action(async (opts: { status?: string; limit: number; json?: boolean }) => {
      const page = await client().get<{ items: BatchJob[] }>("/api/v1/batch/jobs", {
        status: opts.status,
        limit: opts.limit,
      });
      if (opts.json) return json(page);
      if (page.items.length === 0) return out("no jobs");
      out(
        table(
          ["JOB", "STATUS", "AGENT", "AT", "PROGRESS", "CHANGED", "CREATED"],
          page.items.map((j) => [
            j.id,
            j.status,
            String(j.request.agent ?? "-"),
            String((j.request.at as { name?: string } | undefined)?.name ?? "-"),
            `${j.progress.done}/${j.progress.total}`,
            String(j.progress.changed),
            j.createdAt,
          ]),
        ),
      );
    });

  jobs
    .command("show")
    .description("show a job's progress, and its results once finished")
    .argument("<jobId>", "job id")
    .option("--json", "print JSON")
    .action(async (jobId: string, opts: { json?: boolean }) => {
      const job = await client().get<BatchJob>(`/api/v1/batch/jobs/${encodeURIComponent(jobId)}`);
      if (opts.json) return json(job);
      out(`${job.id}  ${job.status}  ${progressLine(job)}`);
      if (job.error) out(`error: ${job.error}`);
      if (job.result) printBatch(job.result as unknown as BatchCliResult);
    });

  jobs
    .command("cancel")
    .description("cancel a queued or running job (a running batch stops before its next trace)")
    .argument("<jobId>", "job id")
    .action(async (jobId: string) => {
      const job = await client().post<BatchJob>(
        `/api/v1/batch/jobs/${encodeURIComponent(jobId)}/cancel`,
        {},
      );
      out(
        job.status === "cancelled"
          ? `cancelled ${job.id}`
          : `asked ${job.id} to stop; it finishes the current trace first`,
      );
    });

  function printBatch(result: BatchCliResult): void {
    if (result.results.length === 0) return out("no traces matched");
    out(
      table(
        ["TRACE", "STARTED", "RESULT", "ORIGINAL", "COUNTERFACTUAL", "DETAIL"],
        result.results.map((r) => [
          r.traceId,
          r.startedAt,
          r.status === "ok" ? (r.outcome?.changed ? "changed" : "same") : r.status,
          r.outcome?.base?.label ?? "-",
          r.outcome?.target?.label ?? "-",
          truncate(
            r.status === "ok"
              ? r.firstDivergence
                ? `#${r.firstDivergence.sequence} ${r.firstDivergence.summary}`
                : "identical"
              : (r.reason ?? ""),
            60,
          ),
        ]),
      ),
    );
    const s = result.summary;
    out(
      `${result.results.length} of ${result.matched} matching trace(s): ${s.changed} changed, ${s.unchanged} unchanged, ${s.skipped} skipped, ${s.failed} failed`,
    );
  }

  /** Poll a job until it leaves queued/running, printing progress whenever it moves. */
  async function waitForJob(
    api: ApiClient,
    jobId: string,
    intervalMs: number,
    report: ((line: string) => void) | null,
  ): Promise<BatchJob> {
    let last = "";
    for (;;) {
      const job = await api.get<BatchJob>(`/api/v1/batch/jobs/${encodeURIComponent(jobId)}`);
      const line = `${job.id}  ${job.status}  ${progressLine(job)}`;
      if (report && line !== last) report(line);
      last = line;
      if (job.status !== "queued" && job.status !== "running") return job;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

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
    .description("compare two branches, of the same trace or of two different traces")
    .argument("<baseBranchId>", "original branch")
    .argument("<targetBranchId>", "counterfactual branch")
    .option("--json", "print JSON")
    .action(async (baseBranchId: string, targetBranchId: string, opts: { json?: boolean }) => {
      const comparison = await client().post<Comparison>("/api/v1/comparisons", {
        baseBranchId,
        targetBranchId,
      });
      if (opts.json) return json(comparison);
      printComparison(comparison);
    });

  const comparisonsCmd = program
    .command("comparisons")
    .description("list and show saved comparisons");

  comparisonsCmd
    .command("list")
    .description("list saved comparisons involving a trace, newest first")
    .argument("<traceId>", "trace id")
    .option("--limit <n>", "maximum rows", positiveInt, 50)
    .option("--json", "print JSON")
    .action(async (traceId: string, opts: { limit: number; json?: boolean }) => {
      const page = await client().get<Page<Comparison>>("/api/v1/comparisons", {
        traceId,
        limit: opts.limit,
      });
      if (opts.json) return json(page);
      if (page.items.length === 0) return out("no comparisons found");
      out(
        table(
          ["COMPARISON", "CREATED", "BASE", "TARGET", "OUTCOME", "FIRST DIVERGENCE"],
          page.items.map((c) => [
            c.id,
            c.createdAt,
            c.result.base.name,
            `${c.result.target.name}${c.targetTraceId && c.targetTraceId !== traceId ? ` (${c.targetTraceId})` : ""}`,
            c.result.outcome.changed ? "changed" : "same",
            c.result.firstDivergence
              ? truncate(
                  `#${c.result.firstDivergence.sequence} ${c.result.firstDivergence.summary}`,
                  60,
                )
              : "identical",
          ]),
        ),
      );
      out(
        `${page.items.length} comparison(s)${page.nextCursor ? " (more available; raise --limit)" : ""}`,
      );
    });

  comparisonsCmd
    .command("show")
    .description("print a saved comparison")
    .argument("<comparisonId>", "comparison id")
    .option("--json", "print JSON")
    .action(async (comparisonId: string, opts: { json?: boolean }) => {
      const comparison = await client().get<Comparison>(
        `/api/v1/comparisons/${encodeURIComponent(comparisonId)}`,
      );
      if (opts.json) return json(comparison);
      printComparison(comparison);
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
  filter: { q?: string; eventType?: string; severity?: string } = {},
): Promise<ShadowEvent[]> {
  const events: ShadowEvent[] = [];
  let cursor: string | undefined;
  do {
    const page = await api.get<Page<ShadowEvent>>(
      `/api/v1/traces/${encodeURIComponent(traceId)}/events`,
      { branchId, cursor, limit: 1000, ...filter },
    );
    events.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return events;
}

/** Text form of an artifact: strings verbatim, everything else pretty-printed JSON. */
interface MatrixAxis {
  kind: "context" | "tool_result" | "policy";
  name: string;
  values: unknown[];
}
interface MatrixCell {
  axis: MatrixAxis;
  value: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Build the axes of a scenario matrix. `--vary key=v1,v2` is one context axis per option;
 * `--vary-tool` and `--vary-policy` take one `name=json` value per option and group repeated
 * names into a single axis, because JSON values may themselves contain commas.
 */
export function matrixAxes(vary: string[], varyTool: string[], varyPolicy: string[]): MatrixAxis[] {
  const axes: MatrixAxis[] = vary.map((item) => {
    const index = item.indexOf("=");
    if (index <= 0) throw new CliError(`--vary expects key=v1,v2 but got '${item}'`, EXIT.usage);
    const key = item.slice(0, index).trim();
    const values = item
      .slice(index + 1)
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
      .map((v) => parseAssignment(`${key}=${v}`).value);
    if (values.length === 0) throw new CliError(`--vary ${key} has no values`, EXIT.usage);
    return { kind: "context", name: key, values };
  });
  const grouped = (items: string[], kind: "tool_result" | "policy", flag: string): MatrixAxis[] => {
    const byName = new Map<string, MatrixAxis>();
    for (const item of items) {
      let parsed: { key: string; value: unknown };
      try {
        parsed = parseAssignment(item);
      } catch (error) {
        throw new CliError(
          `${flag}: ${error instanceof Error ? error.message : String(error)}`,
          EXIT.usage,
        );
      }
      if (kind === "policy" && !isPlainObject(parsed.value)) {
        throw new CliError(`${flag} value for ${parsed.key} must be a JSON object`, EXIT.usage);
      }
      const axis = byName.get(parsed.key) ?? { kind, name: parsed.key, values: [] };
      axis.values.push(parsed.value);
      byName.set(parsed.key, axis);
    }
    return [...byName.values()];
  };
  return [
    ...axes,
    ...grouped(varyTool, "tool_result", "--vary-tool"),
    ...grouped(varyPolicy, "policy", "--vary-policy"),
  ];
}

function matrixOverride(cell: MatrixCell): Record<string, unknown> {
  switch (cell.axis.kind) {
    case "context":
      return { kind: "context", op: "set", key: cell.axis.name, value: cell.value };
    case "tool_result":
      return { kind: "tool_result", tool: cell.axis.name, occurrence: 1, result: cell.value };
    case "policy":
      return { kind: "policy", policy: cell.axis.name, config: cell.value };
  }
}

interface BatchCliResult {
  matched: number;
  summary: { changed: number; unchanged: number; skipped: number; failed: number };
  results: {
    traceId: string;
    startedAt: string;
    status: "ok" | "skipped" | "failed";
    reason?: string;
    outcome?: {
      base: { label: string } | null;
      target: { label: string } | null;
      changed: boolean;
    };
    firstDivergence?: { sequence: number; summary: string } | null;
    comparisonId?: string;
  }[];
}

/** Parse a lifetime such as `90m`, `12h`, `7d` or `2w` into whole hours (at least one). */
function durationHours(value: string): number {
  const match = /^(\d+)\s*(m|h|d|w)$/i.exec(value.trim());
  if (!match)
    throw new CliError(`--expires expects an age such as 12h or 7d, got '${value}'`, EXIT.usage);
  const amount = Number(match[1]);
  const unit = (match[2] ?? "h").toLowerCase();
  const hours =
    unit === "m" ? amount / 60 : unit === "h" ? amount : unit === "d" ? amount * 24 : amount * 168;
  const rounded = Math.max(1, Math.ceil(hours));
  if (rounded > 24 * 30) throw new CliError("--expires is limited to 30d", EXIT.usage);
  return rounded;
}

/** The OS user name, or undefined when it cannot be read (some containers). */
function defaultActor(): string | undefined {
  try {
    return userInfo().username || undefined;
  } catch {
    return undefined;
  }
}

/** One-line summary of an audit entry's details for the table. */
function auditDetail(entry: AuditEntry): string {
  const d = entry.details;
  const pick = (key: string) => (d[key] === undefined ? undefined : JSON.stringify(d[key]));
  return (
    [
      d.name !== undefined ? `name=${String(d.name)}` : undefined,
      d.status !== undefined ? `status=${String(d.status)}` : undefined,
      d.deleted !== undefined ? `deleted=${pick("deleted")}` : undefined,
      d.changes !== undefined ? `changes=${pick("changes")}` : undefined,
      d.overrides !== undefined ? `overrides=${pick("overrides")}` : undefined,
    ]
      .filter((x): x is string => x !== undefined)
      .join(" ") || JSON.stringify(d)
  );
}

interface CollectionChange {
  collection: Collection;
  added: string[];
  missing: string[];
}

function alertValue(rule: AlertRule, value: number | null): string {
  if (value === null) return "-";
  if (rule.metric === "failure_rate") return `${Math.round(value * 100)}%`;
  if (rule.metric === "total_cost") return money(value);
  if (rule.metric === "p95_duration_ms") return duration(value);
  return String(value);
}

function alertTable(rules: AlertRule[]): string {
  return table(
    ["RULE", "STATE", "SCOPE", "METRIC", "THRESHOLD", "VALUE", "WINDOW", "TRACES", "EVALUATED"],
    rules.map((r) => [
      r.name,
      r.enabled ? r.state : "disabled",
      r.agent ?? r.project ?? "all agents",
      r.metric,
      r.mode === "baseline"
        ? `${r.threshold}x ${r.lastBaseline === null ? "baseline" : alertValue(r, r.lastBaseline)}`
        : alertValue(r, r.threshold),
      alertValue(r, r.lastValue),
      `${r.windowMinutes}m`,
      r.lastTraces === null ? "-" : String(r.lastTraces),
      r.lastEvaluatedAt ?? "never",
    ]),
  );
}

/** Parse a window such as `30m`, `6h` or `7d` into minutes (1 minute to 30 days). */
function windowMinutes(value: string): number {
  const match = /^(\d+)\s*(m|h|d)$/i.exec(value.trim());
  if (!match)
    throw new CliError(`--window expects an age such as 30m or 6h, got '${value}'`, EXIT.usage);
  const amount = Number(match[1]);
  const unit = (match[2] ?? "m").toLowerCase();
  const minutes = unit === "m" ? amount : unit === "h" ? amount * 60 : amount * 1440;
  if (minutes < 1 || minutes > 43_200)
    throw new CliError("--window must be between 1m and 30d", EXIT.usage);
  return minutes;
}

const TREND_METRIC_KEYS = [
  "traces",
  "failed",
  "policyViolations",
  "p95DurationMs",
  "totalEstimatedCost",
  "totalTokens",
] as const;
type TrendMetricKey = (typeof TREND_METRIC_KEYS)[number];

interface CliTrend {
  bucket: string;
  from: string;
  to: string;
  points: ({ start: string; traces: number; failed: number } & Record<
    TrendMetricKey,
    number | null
  >)[];
}

/** Unicode block sparkline scaled to the largest value; zero stays at the lowest block. */
export function sparkline(values: readonly number[]): string {
  const blocks = "▁▂▃▄▅▆▇█";
  const max = Math.max(0, ...values);
  if (max === 0) return blocks[0]?.repeat(values.length) ?? "";
  return values
    .map((v) => blocks[Math.min(7, Math.round((Math.max(0, v) / max) * 7))] ?? "")
    .join("");
}

function progressLine(job: BatchJob): string {
  const p = job.progress;
  return `${p.done}/${p.total} trace(s): ${p.changed} changed, ${p.unchanged} unchanged, ${p.skipped} skipped, ${p.failed} failed`;
}

function artifactText(artifact: Artifact): string {
  return typeof artifact.content === "string"
    ? artifact.content
    : JSON.stringify(artifact.content, null, 2);
}

function nonNegative(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0)
    throw new InvalidArgumentError("expected a non-negative number");
  return n;
}

/** Commander parser for cutoff options: ISO timestamps or relative ages. */
function cutoff(value: string): string {
  try {
    return parseCutoff(value);
  } catch (error) {
    throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
  }
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
