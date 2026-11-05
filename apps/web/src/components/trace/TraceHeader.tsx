"use client";

import { api } from "@/lib/api";
import { compact, dateTime, duration, money } from "@/lib/format";
import type { Branch, JsonValue, TraceSummary } from "@shadow/schemas";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
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
  /** Whether the trace's agent has a registered program (forks can be replayed). */
  replayable?: boolean;
  onShowShortcuts?: () => void;
  /** Opens the share-link dialog. */
  onShare?: () => void;
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
  replayable = true,
  onShowShortcuts,
  onShare,
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
          {!replayable && (
            <Badge
              tone="warn"
              title="No program is registered for this agent: forks are created for inspection but cannot be replayed"
            >
              <span data-testid="replay-unavailable-badge">not replayable</span>
            </Badge>
          )}
          <span>{dateTime(trace.startedAt)}</span>
          <TagEditor tags={trace.tags} onChange={onUpdateTags} />
        </div>
        <MetadataChips metadata={trace.metadata} />
        <CollectionChips traceId={trace.id} />
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
        {onShowShortcuts && (
          <Button
            size="xs"
            onClick={onShowShortcuts}
            title="Keyboard shortcuts"
            aria-label="Keyboard shortcuts"
            data-testid="show-shortcuts"
          >
            <Kbd>?</Kbd>
          </Button>
        )}
        <a
          href={api.exportUrl(trace.id)}
          className="inline-flex h-6 items-center rounded border border-border px-2 text-[11px] text-fg-muted hover:bg-hover"
          download
        >
          Export JSON
        </a>
        <a
          href={`${api.exportUrl(trace.id)}?format=markdown`}
          className="inline-flex h-6 items-center rounded border border-border px-2 text-[11px] text-fg-muted hover:bg-hover"
          download
          data-testid="export-markdown"
        >
          Markdown report
        </a>
        <a
          href={api.eventsCsvUrl(trace.id, branch?.id)}
          className="inline-flex h-6 items-center rounded border border-border px-2 text-[11px] text-fg-muted hover:bg-hover"
          download
          title="Download the selected branch's events as CSV for a spreadsheet"
          data-testid="export-events-csv"
        >
          Events CSV
        </a>
        {onShare && (
          <Button
            size="xs"
            onClick={onShare}
            title="Create a read-only link to this trace"
            data-testid="share-trace"
          >
            Share
          </Button>
        )}
      </div>
    </div>
  );
}

/** How many metadata entries the header shows before folding the rest behind a toggle. */
const METADATA_CHIPS = 4;

function chipValue(value: JsonValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * The collections this trace is in, each linking to the explorer filtered to it, and a way to
 * put the trace in another one (created when the name is new).
 */
function CollectionChips({ traceId }: { traceId: string }) {
  const queryClient = useQueryClient();
  const collections = useQuery({
    queryKey: ["collections", traceId],
    queryFn: () => api.collections(traceId),
  });
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const all = useQuery({
    queryKey: ["collections"],
    queryFn: () => api.collections(),
    enabled: adding,
  });
  const add = useMutation({
    mutationFn: async (target: string) => {
      const exists = (all.data?.items ?? []).some((c) => c.name === target);
      return exists
        ? api.addToCollection(target, [traceId])
        : api.createCollection(target, [traceId]);
    },
    onSuccess: async () => {
      setName("");
      setAdding(false);
      await queryClient.invalidateQueries({ queryKey: ["collections"] });
    },
  });
  const items = collections.data?.items ?? [];
  const inOther = (all.data?.items ?? []).filter((c) => !items.some((i) => i.id === c.id));
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1" data-testid="trace-collections">
      {items.length > 0 && <span className="text-[11px] text-fg-faint">in</span>}
      {items.map((c) => (
        <Link
          key={c.id}
          href={`/?collection=${encodeURIComponent(c.name)}`}
          className="inline-flex h-5 max-w-[280px] items-center gap-1 rounded border border-border bg-bg px-1.5 text-[11px] text-fg-muted hover:bg-hover hover:text-fg"
          title={`Show every trace in ${c.name} (${c.traceCount} trace${c.traceCount === 1 ? "" : "s"})`}
          data-testid="collection-chip"
          data-collection={c.name}
        >
          <span className="truncate">{c.name}</span>
          <span className="text-fg-faint">{c.traceCount}</span>
        </Link>
      ))}
      {adding ? (
        <form
          className="flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) add.mutate(name.trim());
          }}
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            list="trace-collection-names"
            placeholder="collection name"
            maxLength={64}
            aria-label="Collection name"
            autoFocus
            className="h-5 w-40 rounded border border-border bg-bg px-1.5 text-[11px]"
            data-testid="trace-collect-name"
          />
          <datalist id="trace-collection-names">
            {inOther.map((c) => (
              <option key={c.id} value={c.name} />
            ))}
          </datalist>
          <Button
            type="submit"
            size="xs"
            variant="primary"
            disabled={!name.trim() || add.isPending}
            data-testid="trace-collect-submit"
          >
            Add
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => {
              setAdding(false);
              setName("");
            }}
          >
            Cancel
          </Button>
          {add.isError && (
            <span className="text-[11px] text-err" role="alert">
              {add.error instanceof Error ? add.error.message : String(add.error)}
            </span>
          )}
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="inline-flex h-5 items-center rounded border border-dashed border-border px-1.5 text-[11px] text-fg-muted hover:bg-hover hover:text-fg"
          title="Put this trace in a collection (created when the name is new)"
          data-testid="trace-collect"
        >
          + collection
        </button>
      )}
    </div>
  );
}

/**
 * The trace's metadata as chips; each links to the explorer filtered to the same entry, so
 * every run for this customer, ticket or batch is one click away.
 */
function MetadataChips({ metadata }: { metadata: Record<string, JsonValue> }) {
  const [expanded, setExpanded] = useState(false);
  const entries = Object.entries(metadata);
  if (entries.length === 0) return null;
  const shown = expanded ? entries : entries.slice(0, METADATA_CHIPS);
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1" data-testid="trace-metadata">
      {shown.map(([key, value]) => {
        const text = chipValue(value);
        return (
          <Link
            key={key}
            href={`/?meta=${encodeURIComponent(`${key}=${text}`)}`}
            className="mono inline-flex h-5 max-w-[280px] items-center gap-1 rounded border border-border bg-bg px-1.5 text-[11px] text-fg-muted hover:bg-hover hover:text-fg"
            title={`Show every trace whose ${key} is ${text}`}
            data-testid="metadata-chip"
            data-key={key}
          >
            <span className="text-fg-faint">{key}</span>
            <span className="truncate">{text}</span>
          </Link>
        );
      })}
      {entries.length > METADATA_CHIPS && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-[11px] text-fg-muted hover:text-fg"
          data-testid="metadata-toggle"
        >
          {expanded ? "fewer" : `+${entries.length - METADATA_CHIPS} more`}
        </button>
      )}
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
