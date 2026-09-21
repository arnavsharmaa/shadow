"use client";

import { api, type AgentStatsRow, type BatchResult } from "@/lib/api";
import { dateTime } from "@/lib/format";
import type { JsonValue } from "@shadow/schemas";
import Link from "next/link";
import { useState } from "react";
import { Badge, Button, Dialog, Spinner } from "../ui/primitives";

interface Props {
  open: boolean;
  onClose: () => void;
  agent: AgentStatsRow;
  /** Tool names recorded anywhere, offered as suggestions for the fork point. */
  tools: string[];
}

function parseValue(text: string): JsonValue {
  try {
    return JSON.parse(text.trim()) as JsonValue;
  } catch {
    return text;
  }
}

/** "What if" across an agent's recorded traces: one context override, many runs. */
export function BatchDialog({ open, onClose, agent, tools }: Props) {
  const [tool, setTool] = useState("");
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [limit, setLimit] = useState(10);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BatchResult | null>(null);
  const canRun = tool.trim() !== "" && key.trim() !== "" && value.trim() !== "" && !running;

  const run = async () => {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      setResult(
        await api.batchCounterfactual({
          agent: agent.agentSlug,
          project: agent.projectSlug,
          at: { eventType: "tool.request", name: tool.trim() },
          overrides: [{ kind: "context", op: "set", key: key.trim(), value: parseValue(value) }],
          limit,
        }),
      );
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
      title={`What if… across ${agent.agentName}`}
      testId="batch-dialog"
      width="max-w-3xl"
    >
      <div className="space-y-4 p-4 text-[12px]">
        <p className="text-fg-muted">
          Re-run the newest recorded traces of <span className="mono">{agent.agentSlug}</span> from
          just before a tool call, with one context value changed, and see how many outcomes change.
          Every run becomes a branch with its own comparison.
        </p>
        <div className="grid grid-cols-4 gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-fg-muted">Fork before tool</span>
            <input
              value={tool}
              onChange={(e) => setTool(e.target.value)}
              list="batch-tools"
              placeholder="refund_order"
              className="h-7 rounded border border-border bg-bg px-2"
              data-testid="batch-tool"
            />
            <datalist id="batch-tools">
              {tools.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-fg-muted">Context key</span>
            <input
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="refundLimit"
              className="h-7 rounded border border-border bg-bg px-2"
              data-testid="batch-key"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-fg-muted">New value (JSON when possible)</span>
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="100"
              className="h-7 rounded border border-border bg-bg px-2"
              data-testid="batch-value"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-fg-muted">Traces (max 50)</span>
            <input
              type="number"
              min={1}
              max={50}
              value={limit}
              onChange={(e) => setLimit(Math.min(50, Math.max(1, Number(e.target.value) || 1)))}
              className="h-7 rounded border border-border bg-bg px-2"
              data-testid="batch-limit"
            />
          </label>
        </div>
        {error && (
          <p className="rounded border border-err/40 bg-err-bg p-2 text-err" role="alert">
            {error}
          </p>
        )}
        {result && (
          <div data-testid="batch-results">
            <p className="mb-2" data-testid="batch-summary">
              <Badge tone={result.summary.changed > 0 ? "warn" : "muted"}>
                {result.summary.changed} changed
              </Badge>{" "}
              <Badge tone="muted">{result.summary.unchanged} unchanged</Badge>{" "}
              <Badge tone="muted">{result.summary.skipped} skipped</Badge>{" "}
              {result.summary.failed > 0 && (
                <Badge tone="err">{result.summary.failed} failed</Badge>
              )}{" "}
              <span className="text-fg-faint">
                of {result.results.length} run ({result.matched} matching)
              </span>
            </p>
            <table className="w-full border-collapse">
              <thead className="text-left text-[11px] uppercase tracking-wide text-fg-muted">
                <tr>
                  <th className="py-1 pr-3">Trace</th>
                  <th className="py-1 pr-3">Original</th>
                  <th className="py-1 pr-3">Counterfactual</th>
                  <th className="py-1 pr-3">Detail</th>
                  <th className="py-1" />
                </tr>
              </thead>
              <tbody>
                {result.results.map((r) => (
                  <tr key={r.traceId} className="border-t border-border" data-testid="batch-row">
                    <td className="py-1.5 pr-3">
                      <Link
                        href={`/traces/${encodeURIComponent(r.traceId)}`}
                        className="text-accent hover:underline"
                      >
                        {r.traceName}
                      </Link>
                      <div className="text-fg-faint">{dateTime(r.startedAt)}</div>
                    </td>
                    <td className="py-1.5 pr-3">
                      {r.status === "ok" ? (r.outcome.base?.label ?? "–") : "–"}
                    </td>
                    <td className="py-1.5 pr-3">
                      {r.status === "ok" ? (
                        <>
                          {r.outcome.target?.label ?? "–"}{" "}
                          {r.outcome.changed ? (
                            <Badge tone="warn">changed</Badge>
                          ) : (
                            <span className="text-fg-faint">same</span>
                          )}
                        </>
                      ) : (
                        <Badge tone={r.status === "failed" ? "err" : "muted"}>{r.status}</Badge>
                      )}
                    </td>
                    <td className="py-1.5 pr-3 text-fg-muted">
                      {r.status === "ok"
                        ? r.firstDivergence
                          ? `#${r.firstDivergence.sequence} ${r.firstDivergence.summary}`
                          : "identical"
                        : r.reason}
                    </td>
                    <td className="py-1.5 text-right">
                      {r.status === "ok" && (
                        <Link
                          href={`/traces/${encodeURIComponent(r.traceId)}/compare?comparison=${encodeURIComponent(r.comparisonId)}`}
                          className="text-accent hover:underline"
                        >
                          Compare
                        </Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
          {running && <Spinner label="Replaying traces" />}
          <Button variant="ghost" onClick={onClose} disabled={running}>
            Close
          </Button>
          <Button variant="primary" onClick={run} disabled={!canRun} data-testid="run-batch">
            Run across {limit} trace{limit === 1 ? "" : "s"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
