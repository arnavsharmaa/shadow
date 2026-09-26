"use client";

import { api, type MatrixVariant } from "@/lib/api";
import { money } from "@/lib/format";
import {
  matrixOverride,
  matrixVariantName,
  parseMatrixValues,
  type MatrixAxis,
} from "@/lib/matrix";
import type { Branch, Override, ShadowEvent } from "@shadow/schemas";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Badge, Button, Dialog, Spinner, outcomeTone } from "../ui/primitives";

const AXIS_LABEL: Record<MatrixAxis, { field: string; placeholder: string; values: string }> = {
  context: { field: "Context key", placeholder: "refundLimit", values: "50, 100, 500" },
  tool_result: {
    field: "Tool",
    placeholder: "refund_order",
    values: '{"status": "processed"}\n{"status": "failed", "error": "card_declined"}',
  },
  policy: { field: "Policy id", placeholder: "refund.autonomous_limit", values: '{"limit": 100}' },
};

interface Props {
  open: boolean;
  onClose: () => void;
  traceId: string;
  branch: Branch;
  event: ShadowEvent;
  /** Called after the matrix ran so the branch list can refresh. */
  onDone: () => Promise<void> | void;
}

/** Scenario matrix: one axis (context key, tool result or policy), several values, every outcome side by side. */
export function MatrixDialog({ open, onClose, traceId, branch, event, onDone }: Props) {
  const toolName = event.eventType.startsWith("tool.") ? event.name : null;
  const policyName = event.eventType.startsWith("policy.") ? event.name : null;
  const [axis, setAxis] = useState<MatrixAxis>(
    toolName ? "tool_result" : policyName ? "policy" : "context",
  );
  const [field, setField] = useState(toolName ?? policyName ?? "");
  const [values, setValues] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<MatrixVariant[] | null>(null);

  const before = useQuery({
    queryKey: ["state-before", branch.id, event.sequence],
    queryFn: () => api.branchState(branch.id, event.sequence - 1),
    enabled: open,
  });
  const contextEntries = useMemo(() => Object.entries(before.data?.context ?? {}), [before.data]);

  const parsed = useMemo(() => parseMatrixValues(values), [values]);
  const variants = useMemo(() => {
    const name = field.trim();
    if (!name) return { list: [], problem: null };
    const list: { name: string; overrides: Override[] }[] = [];
    for (const value of parsed) {
      const built = matrixOverride(axis, name, value);
      if ("error" in built) return { list: [], problem: built.error };
      list.push({ name: matrixVariantName(name, value), overrides: [built.override] });
    }
    return { list, problem: null };
  }, [axis, field, parsed]);
  const canRun =
    variants.list.length > 0 && variants.list.length <= 20 && !variants.problem && !running;

  const switchAxis = (next: MatrixAxis) => {
    setAxis(next);
    setResults(null);
    if (next === "tool_result") setField(toolName ?? "");
    else if (next === "policy") setField(policyName ?? "");
    else setField("");
  };

  const run = async () => {
    setRunning(true);
    setError(null);
    setResults(null);
    try {
      const result = await api.forkMatrix(traceId, {
        forkEventId: event.id,
        parentBranchId: branch.id,
        variants: variants.list,
      });
      setResults(result.variants);
      await onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  const labels = AXIS_LABEL[axis];
  const currentContext =
    axis === "context" ? contextEntries.find(([k]) => k === field.trim()) : undefined;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Scenario matrix"
      testId="matrix-dialog"
      width="max-w-3xl"
    >
      <div className="space-y-4 p-4 text-[12px]">
        <p className="text-fg-muted">
          Rewind to just before{" "}
          <span className="mono">
            #{event.sequence} {event.eventType} <span className="font-semibold">{event.name}</span>
          </span>{" "}
          and replay it once per value. Every variant becomes a branch with its own comparison.
        </p>
        <div className="grid grid-cols-[auto_1fr_2fr] gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-fg-muted">Vary</span>
            <select
              value={axis}
              onChange={(e) => switchAxis(e.target.value as MatrixAxis)}
              className="h-7 rounded border border-border bg-bg px-2"
              data-testid="matrix-axis"
            >
              <option value="context">context value</option>
              <option value="tool_result">tool result</option>
              <option value="policy">policy config</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-fg-muted">{labels.field}</span>
            <input
              value={field}
              onChange={(e) => setField(e.target.value)}
              list={axis === "context" ? "matrix-context-keys" : undefined}
              placeholder={labels.placeholder}
              className="h-7 rounded border border-border bg-bg px-2"
              data-testid="matrix-key"
            />
            <datalist id="matrix-context-keys">
              {contextEntries.map(([k]) => (
                <option key={k} value={k} />
              ))}
            </datalist>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-fg-muted">
              Values, one per line or comma separated (JSON when possible, up to 20)
            </span>
            <textarea
              value={values}
              onChange={(e) => setValues(e.target.value)}
              placeholder={labels.values}
              rows={2}
              className="mono min-h-7 resize-y rounded border border-border bg-bg px-2 py-1"
              data-testid="matrix-values"
            />
          </label>
        </div>
        {axis === "tool_result" && (
          <p className="text-fg-faint">
            Each value replaces the next result of{" "}
            <span className="mono">{field || "the tool"}</span> after the fork point; the recorded
            call is not re-executed.
          </p>
        )}
        {axis === "policy" && (
          <p className="text-fg-faint">
            Each value becomes the configuration object the policy sees, for example{" "}
            <span className="mono">{'{"limit": 100}'}</span>.
          </p>
        )}
        {currentContext && (
          <p className="text-fg-faint">
            Current value: <span className="mono">{JSON.stringify(currentContext[1])}</span>
          </p>
        )}
        {variants.problem && (
          <p className="text-err" data-testid="matrix-problem">
            {variants.problem}
          </p>
        )}
        {parsed.length > 20 && <p className="text-err">At most 20 values per matrix.</p>}
        {error && (
          <p className="rounded border border-err/40 bg-err-bg p-2 text-err" role="alert">
            {error}
          </p>
        )}
        {results && (
          <table className="w-full border-collapse" data-testid="matrix-results">
            <thead className="text-left text-[11px] uppercase tracking-wide text-fg-muted">
              <tr>
                <th className="py-1 pr-3">Variant</th>
                <th className="py-1 pr-3">Outcome</th>
                <th className="py-1 pr-3">First divergence</th>
                <th className="py-1 pr-3 text-right">Cost Δ</th>
                <th className="py-1" />
              </tr>
            </thead>
            <tbody>
              {results.map((v) => (
                <tr key={v.branch.id} className="border-t border-border" data-testid="matrix-row">
                  <td className="mono py-1.5 pr-3">{v.name}</td>
                  <td className="py-1.5 pr-3">
                    <Badge tone={outcomeTone(v.outcome.target?.kind)}>
                      {v.outcome.target?.label ?? v.replay.status}
                    </Badge>{" "}
                    {v.outcome.changed ? (
                      <Badge tone="warn">changed</Badge>
                    ) : (
                      <span className="text-fg-faint">same</span>
                    )}
                  </td>
                  <td className="py-1.5 pr-3 text-fg-muted">
                    {v.firstDivergence
                      ? `#${v.firstDivergence.sequence} ${v.firstDivergence.summary}`
                      : "identical"}
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular">
                    {money(v.deltas.totalEstimatedCost)}
                  </td>
                  <td className="py-1.5 text-right">
                    <Link
                      href={`/traces/${encodeURIComponent(traceId)}/compare?comparison=${encodeURIComponent(v.comparisonId)}`}
                      className="text-accent hover:underline"
                    >
                      Compare
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
          {running && <Spinner label={`Replaying ${variants.list.length} variants`} />}
          <Button variant="ghost" onClick={onClose} disabled={running}>
            Close
          </Button>
          <Button variant="primary" onClick={run} disabled={!canRun} data-testid="run-matrix">
            Run {parsed.length > 0 ? parsed.length : ""} variant{parsed.length === 1 ? "" : "s"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
