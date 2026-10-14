import type { Comparison, JsonValue, Override, ShadowEvent, TraceExport } from "@shadow/schemas";
import { buildEventTree, flattenTree } from "../events/tree.js";

/**
 * Human-readable Markdown for a trace bundle or a comparison: something to paste into an issue,
 * a review or a chat thread. Pure functions over the same data the API serves, so the CLI, the
 * API (`format=markdown`) and the web app render the same report.
 */

export interface TraceReportOptions {
  /** Events listed per branch in the execution section (default 60). */
  maxEvents?: number;
  /** Characters kept of any JSON value shown inline (default 80). */
  valueWidth?: number;
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function table(headers: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.map(cell).join(" | ")} |`;
  return [line(headers), `|${headers.map(() => " --- ").join("|")}|`, ...rows.map(line)].join("\n");
}

export function formatMoney(amount: number, currency = "USD"): string {
  const symbol = currency === "USD" ? "$" : `${currency} `;
  const digits = Math.abs(amount) >= 1 ? 2 : 4;
  return `${amount < 0 ? "-" : ""}${symbol}${Math.abs(amount).toFixed(digits)}`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "-";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes} min ${seconds} s`;
}

function formatPercent(percent: number | null): string {
  if (percent === null || !Number.isFinite(percent)) return "-";
  const value = percent * 100;
  return `${value > 0 ? "+" : ""}${value.toFixed(Math.abs(value) < 10 ? 1 : 0)}%`;
}

function formatDelta(delta: number, digits = 0): string {
  const text = digits > 0 ? delta.toFixed(digits) : String(delta);
  return delta > 0 ? `+${text}` : text;
}

function inline(value: JsonValue | undefined, width: number): string {
  if (value === undefined) return "-";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const flat = text.replace(/\s+/g, " ");
  return `\`${flat.length > width ? `${flat.slice(0, width - 1)}…` : flat}\``;
}

/** One line per override, the same wording across the CLI and reports. */
export function describeOverride(o: Override): string {
  switch (o.kind) {
    case "context":
      return o.op === "set"
        ? `context \`${o.key}\` = ${inline(o.value, 80)}`
        : `remove context \`${o.key}\``;
    case "state":
      return o.op === "set"
        ? `state \`${o.path}\` = ${inline(o.value, 80)}`
        : `remove state \`${o.path}\``;
    case "tool_result":
      return `tool \`${o.tool}\` (call #${o.occurrence}) returns ${inline(o.result, 80)}`;
    case "tool_error":
      return `tool \`${o.tool}\` (call #${o.occurrence}) fails: ${o.error.message}`;
    case "policy":
      return `policy \`${o.policy}\` config ${inline(o.config, 80)}`;
  }
}

function eventLine(event: ShadowEvent, width: number): string {
  const output = event.output as Record<string, JsonValue> | undefined;
  const input = event.input as Record<string, JsonValue> | undefined;
  const parts = [`\`${event.eventType}\``];
  if (event.name !== event.eventType) parts.push(event.name);
  if (event.eventType === "tool.request" && input?.arguments !== undefined) {
    parts.push(inline(input.arguments, width));
  }
  if (event.eventType === "tool.error" || event.eventType === "trace.failed") {
    const error = output?.error as { message?: JsonValue } | undefined;
    if (error && typeof error.message === "string") parts.push(`— ${error.message}`);
  }
  if (event.eventType === "policy.evaluated" && output) {
    const decision = output.decision;
    const reason = output.reason;
    if (typeof decision === "string") parts.push(`→ ${decision}`);
    if (typeof reason === "string") parts.push(`(${reason})`);
  }
  if (event.eventType === "model.response" && output?.finishReason !== undefined) {
    parts.push(`finish: ${String(output.finishReason)}`);
  }
  if (event.durationMs !== null && event.durationMs !== undefined) {
    parts.push(`_${formatDuration(event.durationMs)}_`);
  }
  if (event.estimatedCost && event.estimatedCost.amount > 0) {
    parts.push(`_${formatMoney(event.estimatedCost.amount, event.estimatedCost.currency)}_`);
  }
  return parts.join(" ");
}

function executionSection(events: readonly ShadowEvent[], options: Required<TraceReportOptions>) {
  const nodes = flattenTree(buildEventTree([...events].sort((a, b) => a.sequence - b.sequence)));
  const shown = nodes.slice(0, options.maxEvents);
  const lines = shown.map(
    (node) =>
      `${"  ".repeat(node.depth)}- [${node.event.sequence}] ${eventLine(node.event, options.valueWidth)}`,
  );
  if (nodes.length > shown.length) lines.push(`- … ${nodes.length - shown.length} more events`);
  return lines.join("\n");
}

/** A trace bundle as a Markdown report. */
export function traceReportMarkdown(bundle: TraceExport, options: TraceReportOptions = {}): string {
  const opts: Required<TraceReportOptions> = {
    maxEvents: options.maxEvents ?? 60,
    valueWidth: options.valueWidth ?? 80,
  };
  const { trace } = bundle;
  const metrics = trace.metrics;
  const root = bundle.branches.find((b) => b.id === trace.rootBranchId);
  const sections: string[] = [];
  sections.push(`# ${trace.name}`);
  sections.push(
    table(
      ["Field", "Value"],
      [
        ["Trace", `\`${trace.id}\``],
        [
          "Project / agent",
          `${bundle.project.name} (\`${bundle.project.slug}\`) / ${bundle.agent.name} (\`${bundle.agent.slug}\`)`,
        ],
        ["Status", trace.status],
        ["Outcome", trace.outcome ? `${trace.outcome.label} (\`${trace.outcome.kind}\`)` : "-"],
        ["Started", trace.startedAt],
        ["Duration", formatDuration(trace.durationMs)],
        ["Estimated cost", formatMoney(metrics.totalEstimatedCost, metrics.currency)],
        [
          "Tokens",
          `${metrics.totalTokens} (${metrics.inputTokens} in / ${metrics.outputTokens} out)`,
        ],
        [
          "Model calls / tool calls",
          `${metrics.modelCalls} / ${metrics.toolCalls}${metrics.toolErrors > 0 ? ` (${metrics.toolErrors} tool errors)` : ""}`,
        ],
        ["Policy evaluations", String(metrics.policyEvaluations)],
        ["Tags", trace.tags.length > 0 ? trace.tags.map((t) => `\`${t}\``).join(", ") : "-"],
        ["Branches", String(bundle.branches.length)],
      ],
    ),
  );
  if (bundle.branches.length > 1) {
    const forksById = new Map(bundle.forks.map((f) => [f.id, f]));
    const names = new Map(bundle.branches.map((b) => [b.id, b.name]));
    sections.push("## Branches");
    sections.push(
      table(
        ["Branch", "Status", "Outcome", "Events", "Cost", "Duration", "Forked from"],
        bundle.branches.map((b) => {
          const fork = b.forkId ? forksById.get(b.forkId) : undefined;
          const from = b.parentBranchId
            ? `${names.get(b.parentBranchId) ?? b.parentBranchId} at #${b.forkSequence ?? "?"}${fork && fork.overrides.length > 0 ? `: ${fork.overrides.map(describeOverride).join("; ")}` : ""}`
            : "-";
          return [
            `${b.name} (\`${b.id}\`)`,
            b.status,
            b.outcome?.label ?? "-",
            String(b.metrics.eventCount),
            formatMoney(b.metrics.totalEstimatedCost, b.metrics.currency),
            formatDuration(b.metrics.durationMs),
            from,
          ];
        }),
      ),
    );
  }
  if (root) {
    sections.push(`## Execution (${root.name})`);
    const rootEvents = bundle.events.filter((e) => e.branchId === root.id);
    sections.push(
      rootEvents.length > 0 ? executionSection(rootEvents, opts) : "_No events recorded._",
    );
  }
  if (bundle.replays.length > 0) {
    const names = new Map(bundle.branches.map((b) => [b.id, b.name]));
    sections.push("## Replays");
    sections.push(
      table(
        ["Replay", "Branch", "Mode", "Status", "Events", "Error"],
        bundle.replays.map((r) => [
          `\`${r.id}\``,
          names.get(r.branchId) ?? r.branchId,
          r.mode,
          r.status,
          String(r.eventCount),
          r.error ?? "-",
        ]),
      ),
    );
  }
  if (bundle.comparisons.length > 0) {
    const names = new Map(bundle.branches.map((b) => [b.id, b.name]));
    sections.push("## Comparisons");
    sections.push(
      table(
        ["Comparison", "Base", "Target", "Outcome", "First divergence"],
        bundle.comparisons.map((c) => [
          `\`${c.id}\``,
          names.get(c.baseBranchId) ?? c.baseBranchId,
          names.get(c.targetBranchId) ?? c.targetBranchId,
          c.result.outcome.changed
            ? `${c.result.outcome.base?.label ?? "-"} → ${c.result.outcome.target?.label ?? "-"}`
            : "unchanged",
          c.result.firstDivergence
            ? `#${c.result.firstDivergence.sequence}: ${c.result.firstDivergence.summary}`
            : "none",
        ]),
      ),
    );
  }
  sections.push(`_Exported ${bundle.exportedAt} by Shadow (schema ${bundle.schemaVersion})._`);
  return `${sections.join("\n\n")}\n`;
}

function policyCounts(c: { allow: number; deny: number; approval_required: number }): string {
  return `${c.allow} allow / ${c.deny} deny / ${c.approval_required} approval`;
}

/** A saved comparison as a Markdown report. */
export function comparisonReportMarkdown(comparison: Comparison): string {
  const r = comparison.result;
  const sections: string[] = [];
  sections.push(`# ${r.base.name} vs ${r.target.name}`);
  const intro = [
    `Comparison \`${comparison.id}\` of trace \`${comparison.traceId}\``,
    comparison.targetTraceId ? ` against trace \`${comparison.targetTraceId}\`` : "",
    `, created ${comparison.createdAt}.`,
  ].join("");
  sections.push(intro);
  if (r.overrides.length > 0) {
    sections.push(
      ["## Overrides", ...r.overrides.map((o) => `- ${describeOverride(o)}`)].join("\n"),
    );
  }
  const m = r.metrics;
  sections.push("## Outcome and metrics");
  sections.push(
    table(
      ["Metric", r.base.name, r.target.name, "Delta"],
      [
        [
          "Outcome",
          r.outcome.base?.label ?? "-",
          r.outcome.target?.label ?? "-",
          r.outcome.changed ? "**changed**" : "same",
        ],
        [
          "Estimated cost",
          formatMoney(m.totalEstimatedCost.base),
          formatMoney(m.totalEstimatedCost.target),
          formatPercent(m.totalEstimatedCost.percent),
        ],
        [
          "Duration",
          formatDuration(m.durationMs.base),
          formatDuration(m.durationMs.target),
          formatPercent(m.durationMs.percent),
        ],
        [
          "Tokens",
          String(m.totalTokens.base),
          String(m.totalTokens.target),
          formatPercent(m.totalTokens.percent),
        ],
        [
          "Tool calls",
          String(m.toolCalls.base),
          String(m.toolCalls.target),
          formatDelta(m.toolCalls.delta),
        ],
        [
          "Model calls",
          String(m.modelCalls.base),
          String(m.modelCalls.target),
          formatDelta(m.modelCalls.delta),
        ],
        [
          "Events",
          String(m.eventCount.base),
          String(m.eventCount.target),
          formatDelta(m.eventCount.delta),
        ],
        [
          "Policy decisions",
          policyCounts(r.policy.base),
          policyCounts(r.policy.target),
          r.policy.changed ? "**changed**" : "same",
        ],
      ],
    ),
  );
  sections.push("## First divergence");
  if (r.firstDivergence) {
    const d = r.firstDivergence;
    const lines = [`At sequence ${d.sequence} (${d.reason.replace(/_/g, " ")}): ${d.summary}`];
    for (const f of d.fields.slice(0, 8)) {
      lines.push(`- \`${f.path}\`: ${inline(f.before, 60)} → ${inline(f.after, 60)}`);
    }
    if (d.fields.length > 8) lines.push(`- … ${d.fields.length - 8} more fields`);
    sections.push(lines.join("\n"));
  } else {
    sections.push("None: both branches executed identically.");
  }
  if (r.toolCalls.diffs.length > 0) {
    sections.push("## Tool calls");
    sections.push(
      table(
        ["Tool", "Change", "Detail"],
        r.toolCalls.diffs.slice(0, 20).map((d) => {
          const detail =
            d.kind === "added"
              ? `added in ${r.target.name}`
              : d.kind === "removed"
                ? `only in ${r.base.name}`
                : d.kind === "status"
                  ? `${d.base?.status ?? "-"} → ${d.target?.status ?? "-"}`
                  : d.fields
                      .slice(0, 3)
                      .map((f) => `\`${f.path}\`: ${inline(f.before, 40)} → ${inline(f.after, 40)}`)
                      .join("; ");
          return [`\`${d.tool}\``, d.kind, detail || "-"];
        }),
      ),
    );
  }
  const diffs = [
    ...r.context.diff.map((d) => ({ scope: "context", ...d })),
    ...r.state.diff.map((d) => ({ scope: "state", ...d })),
  ];
  if (diffs.length > 0) {
    sections.push("## Context and state");
    sections.push(
      table(
        ["Scope", "Path", "Change", r.base.name, r.target.name],
        diffs
          .slice(0, 30)
          .map((d) => [d.scope, `\`${d.path}\``, d.op, inline(d.before, 40), inline(d.after, 40)]),
      ),
    );
    if (diffs.length > 30) sections.push(`_… ${diffs.length - 30} more entries._`);
  }
  sections.push(
    `_${r.addedEvents.length} events added, ${r.removedEvents.length} removed, ${r.modifiedEvents.length} modified; shared prefix up to sequence ${r.sharedUntilSequence}._`,
  );
  return `${sections.join("\n\n")}\n`;
}
