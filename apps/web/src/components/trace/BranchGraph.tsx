"use client";

import { api } from "@/lib/api";
import { classNames, duration, money } from "@/lib/format";
import { buildBranchTree, type BranchTreeNode } from "@shadow/core";
import type { Branch, ShadowEvent, TraceSummary } from "@shadow/schemas";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Badge, Button, Dialog, outcomeTone, statusTone } from "../ui/primitives";

interface Props {
  trace: TraceSummary;
  branches: Branch[];
  events: ShadowEvent[];
  currentBranchId: string;
  onSelectBranch: (id: string) => void;
  onChanged: () => Promise<void>;
}

interface Placed {
  branch: Branch;
  column: number;
  row: number;
  parentRow: number | null;
  parentColumn: number | null;
}

const COL = 190;
const ROW = 64;

/** Visual DAG of branches: a lane per branch, connectors from the fork point. */
export function BranchGraph({
  trace,
  branches,
  currentBranchId,
  onSelectBranch,
  onChanged,
}: Props) {
  const [renaming, setRenaming] = useState<Branch | null>(null);
  const [deleting, setDeleting] = useState<Branch | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const placed = useMemo(() => {
    const roots = buildBranchTree(branches);
    const out: Placed[] = [];
    let row = 0;
    const visit = (node: BranchTreeNode, column: number, parent: Placed | null) => {
      const here: Placed = {
        branch: node.branch,
        column,
        row: row++,
        parentRow: parent?.row ?? null,
        parentColumn: parent?.column ?? null,
      };
      out.push(here);
      node.children.forEach((child) => visit(child, column + 1, here));
    };
    roots.forEach((r) => visit(r, 0, null));
    return out;
  }, [branches]);

  const width = (Math.max(...placed.map((p) => p.column)) + 1) * COL + 40;
  const height = placed.length * ROW + 20;
  const root = branches.find((b) => b.parentBranchId === null);

  const rename = async () => {
    if (!renaming) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateBranch(renaming.id, { name: name.trim() });
      await onChanged();
      setRenaming(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteBranch(deleting.id);
      if (deleting.id === currentBranchId && root) onSelectBranch(root.id);
      await onChanged();
      setDeleting(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col" data-testid="branch-graph">
      <div className="overflow-auto p-2">
        <svg width={width} height={height} role="img" aria-label="Branch graph">
          {placed.map((p) => {
            const x = 20 + p.column * COL;
            const y = 10 + p.row * ROW;
            const selected = p.branch.id === currentBranchId;
            return (
              <g key={p.branch.id}>
                {p.parentRow !== null && p.parentColumn !== null && (
                  <path
                    d={`M ${20 + p.parentColumn * COL + 12} ${10 + p.parentRow * ROW + 24} V ${y + 12} H ${x}`}
                    fill="none"
                    stroke="var(--border-strong)"
                    strokeWidth={1.5}
                  />
                )}
                {p.parentRow !== null && (
                  <text
                    x={x - 4}
                    y={y + 8}
                    fontSize={9}
                    fill="var(--fg-faint)"
                    textAnchor="end"
                    fontFamily="var(--font-mono)"
                  >
                    @{p.branch.forkSequence}
                  </text>
                )}
                <foreignObject x={x} y={y} width={COL - 20} height={ROW - 8}>
                  <button
                    type="button"
                    onClick={() => onSelectBranch(p.branch.id)}
                    className={classNames(
                      "flex h-full w-full flex-col items-start rounded border px-2 py-1 text-left text-[11px] hover:bg-hover",
                      selected ? "border-accent bg-selected" : "border-border bg-panel",
                    )}
                    data-testid="branch-node"
                    data-branch-id={p.branch.id}
                    aria-pressed={selected}
                  >
                    <span className="flex w-full items-center gap-1">
                      <span className="mono truncate font-semibold">{p.branch.name}</span>
                      <Badge tone={statusTone(p.branch.status)} className="ml-auto">
                        {p.branch.status}
                      </Badge>
                    </span>
                    <span className="mt-0.5 flex w-full items-center gap-1 text-fg-muted">
                      <span className="tabular">
                        {money(p.branch.metrics.totalEstimatedCost, p.branch.metrics.currency)}
                      </span>
                      <span>·</span>
                      <span className="tabular">{duration(p.branch.metrics.durationMs)}</span>
                    </span>
                    {p.branch.outcome && (
                      <Badge
                        tone={outcomeTone(p.branch.outcome.kind)}
                        className="mt-0.5 max-w-full"
                      >
                        <span className="truncate">{p.branch.outcome.label}</span>
                      </Badge>
                    )}
                  </button>
                </foreignObject>
              </g>
            );
          })}
        </svg>
      </div>
      <div className="border-t border-border">
        <table className="w-full text-[11px]">
          <tbody>
            {branches.map((b) => (
              <tr
                key={b.id}
                className={classNames(
                  "border-b border-border",
                  b.id === currentBranchId && "bg-selected/60",
                )}
              >
                <td className="mono px-2 py-1">
                  {b.name}
                  {b.parentBranchId && (
                    <span className="text-fg-faint">
                      {" "}
                      ← {branches.find((p) => p.id === b.parentBranchId)?.name ?? "?"} @
                      {b.forkSequence}
                    </span>
                  )}
                </td>
                <td className="px-2 py-1 text-right">
                  <span className="flex justify-end gap-1">
                    {b.parentBranchId && root && (
                      <Link
                        href={`/traces/${encodeURIComponent(trace.id)}/compare?base=${encodeURIComponent(root.id)}&target=${encodeURIComponent(b.id)}`}
                        className="rounded border border-border px-1.5 py-0.5 hover:bg-hover"
                      >
                        Compare
                      </Link>
                    )}
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => {
                        setRenaming(b);
                        setName(b.name);
                      }}
                      aria-label={`Rename ${b.name}`}
                    >
                      Rename
                    </Button>
                    {b.parentBranchId && (
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => setDeleting(b)}
                        aria-label={`Delete ${b.name}`}
                      >
                        Delete
                      </Button>
                    )}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Dialog
        open={renaming !== null}
        onClose={() => setRenaming(null)}
        title="Rename branch"
        width="max-w-md"
        testId="rename-dialog"
      >
        <form
          className="space-y-3 p-4 text-[12px]"
          onSubmit={(e) => {
            e.preventDefault();
            void rename();
          }}
        >
          <label htmlFor="branch-name" className="block text-fg-muted">
            New name
          </label>
          <input
            id="branch-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mono h-8 w-full rounded border border-border bg-bg px-2"
            autoFocus
          />
          {error && <p className="text-err">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" type="button" onClick={() => setRenaming(null)}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={busy || !name.trim()}>
              Save
            </Button>
          </div>
        </form>
      </Dialog>

      <Dialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title="Delete branch"
        width="max-w-md"
        testId="delete-dialog"
      >
        <div className="space-y-3 p-4 text-[12px]">
          <p>
            Delete <span className="mono font-semibold">{deleting?.name}</span> and all branches
            forked from it? Its replayed events and comparisons are removed. The original execution
            is not affected.
          </p>
          {error && <p className="text-err">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={remove} disabled={busy} data-testid="confirm-delete">
              Delete branch
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
