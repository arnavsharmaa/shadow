"use client";

import { api } from "@/lib/api";
import { compact, dateTime, duration, money } from "@/lib/format";
import type { Branch, TraceSummary } from "@shadow/schemas";
import Link from "next/link";
import { Badge, Button, Kbd, outcomeTone, statusTone } from "../ui/primitives";
import { TagEditor } from "./TagEditor";

interface Props {
  trace: TraceSummary;
  branches: Branch[];
  branch: Branch | null;
  onSelectBranch: (id: string) => void;
  onOpenBranches: () => void;
  onJumpError: () => void;
  onJumpPolicy: () => void;
  hasError: boolean;
  hasPolicy: boolean;
  onUpdateTags: (change: { addTags?: string[]; removeTags?: string[] }) => Promise<void>;
}

export function TraceHeader({
  trace,
  branches,
  branch,
  onSelectBranch,
  onOpenBranches,
  onJumpError,
  onJumpPolicy,
  hasError,
  hasPolicy,
  onUpdateTags,
}: Props) {
  const metrics = branch?.metrics ?? trace.metrics;
  const outcome = branch?.outcome ?? trace.outcome;
  const root = branches.find((b) => b.parentBranchId === null);
  const compareTarget =
    branch && root && branch.id !== root.id
      ? branch
      : branches.find((b) => b.parentBranchId !== null);
  return (
    <div
      className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-border bg-panel px-3 py-2"
      data-testid="trace-header"
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <Link href="/" className="text-[11px] text-fg-muted hover:text-fg">
            Traces
          </Link>
          <span className="text-fg-faint">/</span>
          <h1 className="truncate text-[13px] font-semibold" title={trace.name}>
            {trace.name}
          </h1>
          <Badge tone={statusTone(branch?.status ?? trace.status)}>
            {branch?.status ?? trace.status}
          </Badge>
          {outcome && (
            <Badge
              tone={outcomeTone(outcome.kind)}
              title={outcome.summary}
              className="max-w-[320px]"
            >
              <span className="truncate" data-testid="branch-outcome">
                {outcome.label}
              </span>
            </Badge>
          )}
        </div>
        <div className="mono mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-fg-muted">
          <span>{trace.id}</span>
          <span>
            {trace.projectSlug} / {trace.agentSlug}
          </span>
          <span>{dateTime(trace.startedAt)}</span>
          <TagEditor tags={trace.tags} onChange={onUpdateTags} />
        </div>
      </div>
      <dl className="ml-auto flex flex-wrap items-center gap-x-4 text-[11px]">
        <Stat label="Duration" value={duration(metrics.durationMs)} />
        <Stat label="Model" value={String(metrics.modelCalls)} />
        <Stat
          label="Tools"
          value={
            metrics.toolErrors > 0
              ? `${metrics.toolCalls} (${metrics.toolErrors} err)`
              : String(metrics.toolCalls)
          }
        />
        <Stat
          label="Tokens"
          value={compact(metrics.totalTokens)}
          title={`${metrics.inputTokens} in / ${metrics.outputTokens} out`}
        />
        <Stat
          label="Est. cost"
          value={money(metrics.totalEstimatedCost, metrics.currency)}
          title="Estimated from the pricing table"
        />
      </dl>
      <div className="flex items-center gap-1.5">
        <label htmlFor="branch-select" className="text-[11px] text-fg-muted">
          Branch
        </label>
        <select
          id="branch-select"
          data-testid="branch-select"
          value={branch?.id ?? ""}
          onChange={(e) => onSelectBranch(e.target.value)}
          className="mono h-7 rounded border border-border bg-bg px-1 text-[12px]"
        >
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
              {b.parentBranchId ? ` (fork @${b.forkSequence})` : ""} · {b.status}
            </option>
          ))}
        </select>
        <Button size="xs" onClick={onOpenBranches} title="Show the branch graph">
          Graph <Kbd>b</Kbd>
        </Button>
        {compareTarget && root && (
          <Link
            href={`/traces/${encodeURIComponent(trace.id)}/compare?base=${encodeURIComponent(root.id)}&target=${encodeURIComponent(compareTarget.id)}`}
            className="inline-flex h-6 items-center rounded border border-border-strong bg-panel px-2 text-[11px] font-medium hover:bg-hover"
            data-testid="compare-link"
          >
            Compare {compareTarget.name} vs {root.name}
          </Link>
        )}
        <Button
          size="xs"
          disabled={!hasError}
          onClick={onJumpError}
          title="Jump to the first error"
        >
          First error <Kbd>e</Kbd>
        </Button>
        <Button
          size="xs"
          disabled={!hasPolicy}
          onClick={onJumpPolicy}
          title="Jump to the first policy denial or approval requirement"
        >
          First policy <Kbd>p</Kbd>
        </Button>
        <a
          href={api.exportUrl(trace.id)}
          className="inline-flex h-6 items-center rounded border border-border px-2 text-[11px] text-fg-muted hover:bg-hover"
          download
        >
          Export JSON
        </a>
      </div>
    </div>
  );
}

function Stat({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="flex items-baseline gap-1" title={title}>
      <dt className="text-fg-muted">{label}</dt>
      <dd className="tabular font-medium">{value}</dd>
    </div>
  );
}
