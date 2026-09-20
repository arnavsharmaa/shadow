"use client";

import { api, type MatrixVariant } from "@/lib/api";
import { money } from "@/lib/format";
import type { Branch, JsonValue, ShadowEvent } from "@shadow/schemas";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Badge, Button, Dialog, Spinner, outcomeTone } from "../ui/primitives";

interface Props {
  open: boolean;
  onClose: () => void;
  traceId: string;
  branch: Branch;
  event: ShadowEvent;
  /** Called after the matrix ran so the branch list can refresh. */
  onDone: () => Promise<void> | void;
}

function parseValue(text: string): JsonValue {
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return text;
  }
}

/** Scenario matrix: one context key, several values, every outcome side by side. */
export function MatrixDialog({ open, onClose, traceId, branch, event, onDone }: Props) {
  const [key, setKey] = useState("");
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

  const parsed = useMemo(
    () =>
      values
        .split(",")
        .map((v) => v.trim())
        .filter((v) => v.length > 0)
        .map(parseValue),
    [values],
  );
  const canRun = key.trim().length > 0 && parsed.length > 0 && parsed.length <= 20 && !running;

  const run = async () => {
    setRunning(true);
    setError(null);
    setResults(null);
    try {
      const result = await api.forkMatrix(traceId, {
        forkEventId: event.id,
        parentBranchId: branch.id,
        variants: parsed.map((value) => ({
          name: `${key.trim()}=${JSON.stringify(value)}`.slice(0, 120),
          overrides: [{ kind: "context", op: "set", key: key.trim(), value }],
        })),
      });
      setResults(result.variants);
      await onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

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
        <div className="grid grid-cols-[1fr_2fr] gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-fg-muted">Context key</span>
            <input
              value={key}
              onChange={(e) => setKey(e.target.value)}
              list="matrix-context-keys"
              placeholder="refundLimit"
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
              Values, comma separated (parsed as JSON when possible, up to 20)
            </span>
            <input
              value={values}
              onChange={(e) => setValues(e.target.value)}
              placeholder="50, 100, 500"
              className="h-7 rounded border border-border bg-bg px-2"
              data-testid="matrix-values"
            />
          </label>
        </div>
        {key && contextEntries.some(([k]) => k === key) && (
          <p className="text-fg-faint">
            Current value:{" "}
            <span className="mono">
              {JSON.stringify(contextEntries.find(([k]) => k === key)?.[1])}
            </span>
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
          {running && <Spinner label={`Replaying ${parsed.length} variants`} />}
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
