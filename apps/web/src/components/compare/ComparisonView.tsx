"use client";

import { api } from "@/lib/api";
import { classNames, compact, duration, money, percent } from "@/lib/format";
import type {
  AlignedStep,
  Comparison,
  ComparisonResult,
  Delta,
  EventRef,
  Override,
  ToolCallDiff,
} from "@shadow/schemas";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { inlineJson } from "../json/JsonView";
import { DiffTable, FieldDiffTable } from "../trace/DiffTable";
import {
  Badge,
  Button,
  ErrorState,
  Panel,
  Skeleton,
  eventTone,
  outcomeTone,
} from "../ui/primitives";

export function ComparisonView({ traceId }: { traceId: string }) {
  const params = useSearchParams();
  const comparisonId = params.get("comparison");
  const base = params.get("base");
  const target = params.get("target");

  const query = useQuery({
    queryKey: ["comparison", comparisonId, base, target],
    queryFn: async (): Promise<Comparison> => {
      if (comparisonId) return api.comparison(comparisonId);
      if (base && target) return api.createComparison(base, target);
      throw new Error("Provide ?comparison=<id> or ?base=<branchId>&target=<branchId>");
    },
  });

  if (query.isError) return <ErrorState error={query.error} retry={() => query.refetch()} />;
  if (!query.data) {
    return (
      <div className="space-y-2 p-3" aria-busy="true" aria-label="Loading comparison">
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-[50vh] w-full" />
      </div>
    );
  }
  return <ComparisonBody traceId={traceId} comparison={query.data} />;
}

function ComparisonBody({ traceId, comparison }: { traceId: string; comparison: Comparison }) {
  const r = comparison.result;
  const [showShared, setShowShared] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(r.firstDivergence?.stepIndex ?? null);
  const markdown = useMemo(() => toMarkdown(comparison), [comparison]);
  const [copied, setCopied] = useState(false);

  const visibleSteps = showShared ? r.steps : r.steps.filter((s) => s.kind !== "shared");
  const sharedCount = r.steps.filter((s) => s.kind === "shared").length;

  return (
    <div className="flex h-full flex-col" data-testid="comparison-view">
      <div className="flex flex-wrap items-center gap-3 border-b border-border bg-panel px-3 py-2">
        <div className="flex items-center gap-2 text-[11px] text-fg-muted">
          <Link href={`/traces/${encodeURIComponent(traceId)}`} className="hover:text-fg">
            ← Trace
          </Link>
          <span className="mono">{comparison.id}</span>
        </div>
        <h1 className="flex items-center gap-2 text-[13px] font-semibold">
          <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] uppercase tracking-wide text-fg-muted">
            Original
          </span>
          <Link
            href={`/traces/${encodeURIComponent(traceId)}?branch=${encodeURIComponent(r.base.branchId)}`}
            className="mono hover:underline"
            data-testid="base-branch-name"
          >
            {r.base.name}
          </Link>
          <span className="text-fg-faint">vs</span>
          <span className="rounded bg-info-bg px-1.5 py-0.5 text-[11px] uppercase tracking-wide text-info">
            Counterfactual
          </span>
          <Link
            href={`/traces/${encodeURIComponent(traceId)}?branch=${encodeURIComponent(r.target.branchId)}`}
            className="mono hover:underline"
            data-testid="target-branch-name"
          >
            {r.target.name}
          </Link>
        </h1>
        <div className="ml-auto flex items-center gap-2">
          <Button
            size="xs"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(markdown);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              } catch {
                setCopied(false);
              }
            }}
          >
            {copied ? "Copied" : "Copy Markdown summary"}
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <div
          className="grid grid-cols-2 gap-px bg-border md:grid-cols-4 xl:grid-cols-7"
          data-testid="comparison-metrics"
        >
          <MetricCard
            label="Outcome"
            base={r.outcome.base?.label ?? "–"}
            target={r.outcome.target?.label ?? "–"}
            changed={r.outcome.changed}
            tones={[outcomeTone(r.outcome.base?.kind), outcomeTone(r.outcome.target?.kind)]}
            testId="metric-outcome"
          />
          <DeltaCard
            label="Est. cost"
            delta={r.metrics.totalEstimatedCost}
            format={(v) => money(v, r.base.metrics.currency)}
            lowerIsBetter
            testId="metric-cost"
          />
          <DeltaCard
            label="Latency"
            delta={r.metrics.durationMs}
            format={duration}
            lowerIsBetter
            testId="metric-latency"
          />
          <DeltaCard label="Tokens" delta={r.metrics.totalTokens} format={compact} lowerIsBetter />
          <DeltaCard label="Tool calls" delta={r.metrics.toolCalls} format={String} />
          <DeltaCard label="Model calls" delta={r.metrics.modelCalls} format={String} />
          <MetricCard
            label="Policy decisions"
            base={policyLabel(r.policy.base)}
            target={policyLabel(r.policy.target)}
            changed={r.policy.changed}
            tones={[
              r.policy.base.deny > 0 ? "err" : "ok",
              r.policy.target.deny > 0
                ? "err"
                : r.policy.target.approval_required > 0
                  ? "warn"
                  : "ok",
            ]}
            testId="metric-policy"
          />
        </div>

        <div className="grid gap-px bg-border lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div className="flex min-w-0 flex-col gap-px bg-border">
            <Panel title="First divergence" className="border-0" bodyClassName="p-3">
              {r.firstDivergence ? (
                <div data-testid="first-divergence">
                  <p className="text-[13px]">
                    <span className="mono rounded bg-muted px-1">
                      step {r.firstDivergence.stepIndex}
                    </span>{" "}
                    <span className="mono rounded bg-muted px-1">
                      sequence {r.firstDivergence.sequence}
                    </span>{" "}
                    <Badge tone="warn">{r.firstDivergence.reason.replace("_", " ")}</Badge>
                  </p>
                  <p
                    className="mt-1 text-[13px] font-medium"
                    data-testid="first-divergence-summary"
                  >
                    {r.firstDivergence.summary}
                  </p>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <SideEvent
                      label="Original"
                      eventRef={r.firstDivergence.base}
                      traceId={traceId}
                      branchId={r.base.branchId}
                    />
                    <SideEvent
                      label="Counterfactual"
                      eventRef={r.firstDivergence.target}
                      traceId={traceId}
                      branchId={r.target.branchId}
                    />
                  </div>
                  {r.firstDivergence.fields.length > 0 && (
                    <div className="mt-2">
                      <FieldDiffTable
                        fields={r.firstDivergence.fields}
                        testId="first-divergence-fields"
                      />
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-fg-muted">
                  No divergence: both branches executed identically after the shared prefix.
                </p>
              )}
            </Panel>

            <Panel
              title={`Aligned execution (${r.steps.length} steps · ${sharedCount} shared · ${r.modifiedEvents.length} modified · ${r.addedEvents.length} added · ${r.removedEvents.length} removed)`}
              className="border-0"
              actions={
                <label className="flex items-center gap-1 text-[11px] text-fg-muted">
                  <input
                    type="checkbox"
                    checked={showShared}
                    onChange={(e) => setShowShared(e.target.checked)}
                  />{" "}
                  show shared prefix
                </label>
              }
            >
              <table className="w-full border-collapse text-[12px]" data-testid="aligned-steps">
                <thead className="sticky top-0 bg-panel text-left text-[11px] uppercase tracking-wide text-fg-muted">
                  <tr>
                    <th className="border-b border-border px-2 py-1 w-10">#</th>
                    <th className="border-b border-border px-2 py-1 w-20">Kind</th>
                    <th className="border-b border-border px-2 py-1">Original</th>
                    <th className="border-b border-border px-2 py-1">Counterfactual</th>
                  </tr>
                </thead>
                <tbody>
                  {!showShared && sharedCount > 0 && (
                    <tr className="border-b border-border text-fg-faint">
                      <td className="px-2 py-1" colSpan={4}>
                        {sharedCount} shared events (identical prefix up to sequence{" "}
                        {r.sharedUntilSequence}) hidden
                      </td>
                    </tr>
                  )}
                  {visibleSteps.map((step) => (
                    <StepRow
                      key={step.index}
                      step={step}
                      expanded={expanded === step.index}
                      onToggle={() => setExpanded((e) => (e === step.index ? null : step.index))}
                      isFirst={r.firstDivergence?.stepIndex === step.index}
                    />
                  ))}
                </tbody>
              </table>
            </Panel>
          </div>

          <div className="flex min-w-0 flex-col gap-px bg-border">
            <Panel title="Overrides applied" className="border-0" bodyClassName="p-2">
              {r.overrides.length === 0 ? (
                <p className="text-fg-faint">None</p>
              ) : (
                <ul className="space-y-1 text-[12px]" data-testid="applied-overrides">
                  {r.overrides.map((o, i) => (
                    <li
                      key={o.id ?? i}
                      className="mono rounded border border-border bg-bg px-2 py-1"
                    >
                      {describeOverride(o)}
                      {o.label && <span className="ml-2 text-fg-faint">{o.label}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
            <Panel title="Context (final)" className="border-0">
              <DiffTable
                entries={r.context.diff}
                emptyLabel="Identical context"
                labels={["Original", "Counterfactual"]}
                testId="context-diff"
              />
            </Panel>
            <Panel title="State (final)" className="border-0">
              <DiffTable
                entries={r.state.diff}
                emptyLabel="Identical state"
                labels={["Original", "Counterfactual"]}
                testId="state-diff"
              />
            </Panel>
            <Panel title={`Tool calls (${r.toolCalls.diffs.length} differ)`} className="border-0">
              {r.toolCalls.diffs.length === 0 ? (
                <p className="p-2 text-fg-faint">Identical tool calls</p>
              ) : (
                r.toolCalls.diffs.map((d, i) => <ToolDiff key={i} diff={d} />)
              )}
            </Panel>
            <Panel title="Policy decisions" className="border-0">
              <div className="grid grid-cols-2 gap-px bg-border text-[12px]">
                <PolicyList label="Original" decisions={r.policy.baseDecisions} />
                <PolicyList label="Counterfactual" decisions={r.policy.targetDecisions} />
              </div>
            </Panel>
          </div>
        </div>
      </div>
    </div>
  );
}

function policyLabel(c: { allow: number; deny: number; approval_required: number }): string {
  return `${c.allow} allow · ${c.deny} deny · ${c.approval_required} approval`;
}

function MetricCard({
  label,
  base,
  target,
  changed,
  tones,
  testId,
}: {
  label: string;
  base: string;
  target: string;
  changed: boolean;
  tones: [ReturnType<typeof outcomeTone>, ReturnType<typeof outcomeTone>];
  testId?: string;
}) {
  return (
    <div className="bg-panel p-2" data-testid={testId}>
      <p className="text-[11px] uppercase tracking-wide text-fg-muted">{label}</p>
      <div className="mt-1 space-y-1">
        <div className="flex items-center gap-1 text-[12px]">
          <span className="w-7 text-fg-faint">orig</span>
          <Badge tone={tones[0]} className="max-w-full">
            <span className="truncate" data-testid={testId ? `${testId}-base` : undefined}>
              {base}
            </span>
          </Badge>
        </div>
        <div className="flex items-center gap-1 text-[12px]">
          <span className="w-7 text-fg-faint">fork</span>
          <Badge tone={tones[1]} className="max-w-full">
            <span className="truncate" data-testid={testId ? `${testId}-target` : undefined}>
              {target}
            </span>
          </Badge>
        </div>
        <p className={classNames("text-[11px]", changed ? "text-warn" : "text-fg-faint")}>
          {changed ? "changed" : "unchanged"}
        </p>
      </div>
    </div>
  );
}

function DeltaCard({
  label,
  delta,
  format,
  lowerIsBetter,
  testId,
}: {
  label: string;
  delta: Delta;
  format: (v: number) => string;
  lowerIsBetter?: boolean;
  testId?: string;
}) {
  const tone =
    delta.delta === 0
      ? "text-fg-faint"
      : lowerIsBetter
        ? delta.delta < 0
          ? "text-ok"
          : "text-err"
        : "text-fg";
  return (
    <div className="bg-panel p-2" data-testid={testId}>
      <p className="text-[11px] uppercase tracking-wide text-fg-muted">{label}</p>
      <div className="mt-1 space-y-0.5 text-[12px]">
        <div className="flex gap-1">
          <span className="w-7 text-fg-faint">orig</span>
          <span className="tabular">{format(delta.base)}</span>
        </div>
        <div className="flex gap-1">
          <span className="w-7 text-fg-faint">fork</span>
          <span className="tabular">{format(delta.target)}</span>
        </div>
        <p
          className={classNames("tabular text-[11px]", tone)}
          data-testid={testId ? `${testId}-delta` : undefined}
        >
          {delta.delta > 0 ? "+" : delta.delta < 0 ? "-" : ""}
          {format(Math.abs(delta.delta))} ({percent(delta.percent)})
        </p>
      </div>
    </div>
  );
}

function SideEvent({
  label,
  eventRef,
  traceId,
  branchId,
}: {
  label: string;
  eventRef: EventRef | null;
  traceId: string;
  branchId: string;
}) {
  const ref = eventRef;
  if (!ref) {
    return (
      <div className="rounded border border-dashed border-border p-2 text-fg-faint">
        <p className="text-[11px] uppercase tracking-wide">{label}</p>
        <p>(no corresponding event)</p>
      </div>
    );
  }
  return (
    <Link
      href={`/traces/${encodeURIComponent(traceId)}?branch=${encodeURIComponent(branchId)}&event=${encodeURIComponent(ref.id)}`}
      className="rounded border border-border bg-bg p-2 hover:bg-hover"
    >
      <p className="text-[11px] uppercase tracking-wide text-fg-muted">{label}</p>
      <p className="mono">
        #{ref.sequence} <Badge tone={eventTone(ref.eventType)}>{ref.eventType}</Badge> {ref.name}
      </p>
    </Link>
  );
}

const kindTone: Record<AlignedStep["kind"], string> = {
  shared: "text-fg-faint",
  same: "text-fg-muted",
  modified: "bg-diff-mod",
  added: "bg-diff-add",
  removed: "bg-diff-del",
  override: "bg-info-bg",
};

function StepRow({
  step,
  expanded,
  onToggle,
  isFirst,
}: {
  step: AlignedStep;
  expanded: boolean;
  onToggle: () => void;
  isFirst: boolean;
}) {
  const cell = (ref: AlignedStep["base"]) =>
    ref ? (
      <span className="mono">
        <span className="text-fg-faint">#{ref.sequence}</span>{" "}
        <Badge tone={eventTone(ref.eventType)}>{ref.eventType}</Badge> {ref.name}
      </span>
    ) : (
      <span className="text-fg-faint">–</span>
    );
  return (
    <>
      <tr
        className={classNames(
          "cursor-pointer border-b border-border align-top hover:bg-hover",
          kindTone[step.kind],
          isFirst && "outline outline-1 outline-warn",
        )}
        onClick={onToggle}
        data-testid="aligned-step"
        data-kind={step.kind}
      >
        <td className="mono px-2 py-1 text-fg-faint">{step.index}</td>
        <td className="px-2 py-1">
          <Badge
            tone={
              step.kind === "modified"
                ? "warn"
                : step.kind === "added"
                  ? "ok"
                  : step.kind === "removed"
                    ? "err"
                    : step.kind === "override"
                      ? "info"
                      : "muted"
            }
          >
            {step.kind}
          </Badge>
          {isFirst && <span className="ml-1 text-[10px] text-warn">first</span>}
        </td>
        <td className="px-2 py-1">{cell(step.base)}</td>
        <td className="px-2 py-1">{cell(step.target)}</td>
      </tr>
      {expanded && step.fields.length > 0 && (
        <tr className="border-b border-border bg-bg">
          <td colSpan={4} className="p-2">
            <FieldDiffTable fields={step.fields} />
          </td>
        </tr>
      )}
    </>
  );
}

function ToolDiff({ diff }: { diff: ToolCallDiff }) {
  return (
    <div className="border-b border-border p-2 text-[12px]">
      <p className="mono">
        <span className="font-semibold">{diff.tool}</span>{" "}
        <Badge tone={diff.kind === "added" ? "ok" : diff.kind === "removed" ? "err" : "warn"}>
          {diff.kind}
        </Badge>
      </p>
      <div className="mt-1 grid grid-cols-2 gap-2">
        <div className="min-w-0">
          <p className="text-[10px] uppercase text-fg-muted">Original</p>
          <p className="mono break-all text-fg-muted">
            {diff.base
              ? `${diff.base.status} · ${inlineJson(diff.base.error ?? diff.base.result, 120)}`
              : "(not called)"}
          </p>
        </div>
        <div className="min-w-0">
          <p className="text-[10px] uppercase text-fg-muted">Counterfactual</p>
          <p className="mono break-all text-fg-muted">
            {diff.target
              ? `${diff.target.status} · ${inlineJson(diff.target.error ?? diff.target.result, 120)}`
              : "(not called)"}
          </p>
        </div>
      </div>
      {diff.fields.length > 0 && (
        <div className="mt-1">
          <FieldDiffTable fields={diff.fields} />
        </div>
      )}
    </div>
  );
}

function PolicyList({
  label,
  decisions,
}: {
  label: string;
  decisions: ComparisonResult["policy"]["baseDecisions"];
}) {
  return (
    <div className="bg-panel p-2">
      <p className="text-[11px] uppercase tracking-wide text-fg-muted">{label}</p>
      {decisions.length === 0 ? (
        <p className="text-fg-faint">none</p>
      ) : (
        <ul className="mt-1 space-y-1">
          {decisions.map((d) => (
            <li key={d.eventId} className="mono">
              <span className="text-fg-faint">#{d.sequence}</span> {d.policy}{" "}
              <Badge tone={d.decision === "allow" ? "ok" : d.decision === "deny" ? "err" : "warn"}>
                {d.decision.toUpperCase()}
              </Badge>
              {d.reason && <p className="text-[11px] text-fg-muted">{d.reason}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function describeOverride(o: Override): string {
  switch (o.kind) {
    case "context":
      return o.op === "set"
        ? `context.${o.key} = ${JSON.stringify(o.value)}`
        : `remove context.${o.key}`;
    case "state":
      return o.op === "set"
        ? `state ${o.path} = ${JSON.stringify(o.value)}`
        : `remove state ${o.path}`;
    case "tool_result":
      return `${o.tool} (call #${o.occurrence}) returns ${JSON.stringify(o.result)}`;
    case "tool_error":
      return `${o.tool} (call #${o.occurrence}) fails: ${o.error.message}`;
    case "policy":
      return `policy ${o.policy} config ${JSON.stringify(o.config)}`;
  }
}

function toMarkdown(c: Comparison): string {
  const r = c.result;
  const lines = [
    `# Shadow comparison: ${r.base.name} vs ${r.target.name}`,
    "",
    `Trace: \`${c.traceId}\` · comparison \`${c.id}\``,
    "",
    "| Metric | Original | Counterfactual | Delta |",
    "| --- | --- | --- | --- |",
    `| Outcome | ${r.outcome.base?.label ?? "-"} | ${r.outcome.target?.label ?? "-"} | ${r.outcome.changed ? "changed" : "same"} |`,
    `| Est. cost | ${money(r.metrics.totalEstimatedCost.base)} | ${money(r.metrics.totalEstimatedCost.target)} | ${percent(r.metrics.totalEstimatedCost.percent)} |`,
    `| Latency | ${duration(r.metrics.durationMs.base)} | ${duration(r.metrics.durationMs.target)} | ${percent(r.metrics.durationMs.percent)} |`,
    `| Tokens | ${r.metrics.totalTokens.base} | ${r.metrics.totalTokens.target} | ${percent(r.metrics.totalTokens.percent)} |`,
    `| Tool calls | ${r.metrics.toolCalls.base} | ${r.metrics.toolCalls.target} | ${r.metrics.toolCalls.delta} |`,
    `| Policy | ${policyLabel(r.policy.base)} | ${policyLabel(r.policy.target)} | ${r.policy.changed ? "changed" : "same"} |`,
    "",
    "## Overrides",
    ...(r.overrides.length ? r.overrides.map((o) => `- ${describeOverride(o)}`) : ["- none"]),
    "",
    "## First divergence",
    r.firstDivergence
      ? `Sequence ${r.firstDivergence.sequence}: ${r.firstDivergence.summary}`
      : "None",
    ...(r.firstDivergence?.fields.map(
      (f) => `- \`${f.path}\`: ${JSON.stringify(f.before)} → ${JSON.stringify(f.after)}`,
    ) ?? []),
    "",
    `Added ${r.addedEvents.length}, removed ${r.removedEvents.length}, modified ${r.modifiedEvents.length} events.`,
  ];
  return lines.join("\n");
}
