"use client";

import { api, type AgentStatsRow, type BatchResult } from "@/lib/api";
import { dateTime } from "@/lib/format";
import type { BatchJob, JsonValue } from "@shadow/schemas";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
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

const SYNC_LIMIT = 50;
const BACKGROUND_LIMIT = 500;
const POLL_MS = 750;

/** "What if" across an agent's recorded traces: one context override, many runs. */
export function BatchDialog({ open, onClose, agent, tools }: Props) {
  const [tool, setTool] = useState("");
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [limit, setLimit] = useState(10);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BatchResult | null>(null);
  const [background, setBackground] = useState(false);
  const [job, setJob] = useState<BatchJob | null>(null);
  // Stops polling once the dialog is gone; the job itself keeps running on the server.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const maxLimit = background ? BACKGROUND_LIMIT : SYNC_LIMIT;
  const canRun = tool.trim() !== "" && key.trim() !== "" && value.trim() !== "" && !running;

  const run = async () => {
    setRunning(true);
    setError(null);
    setResult(null);
    setJob(null);
    const body = {
      agent: agent.agentSlug,
      project: agent.projectSlug,
      at: { eventType: "tool.request", name: tool.trim() },
      overrides: [
        { kind: "context" as const, op: "set" as const, key: key.trim(), value: parseValue(value) },
      ],
      limit: Math.min(limit, maxLimit),
    };
    try {
      if (!background) {
        setResult(await api.batchCounterfactual(body));
        return;
      }
      let current = await api.startBatchJob(body);
      setJob(current);
      while (alive.current && (current.status === "queued" || current.status === "running")) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        current = await api.batchJob(current.id);
        if (alive.current) setJob(current);
      }
      if (current.result) setResult(current.result as unknown as BatchResult);
      if (current.status === "failed") setError(current.error ?? "the batch job failed");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  const cancelJob = async () => {
    if (!job) return;
    try {
      setJob(await api.cancelBatchJob(job.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
            <span className="text-[11px] text-fg-muted">Traces (max {maxLimit})</span>
            <input
              type="number"
              min={1}
              max={maxLimit}
              value={limit}
              onChange={(e) =>
                setLimit(Math.min(maxLimit, Math.max(1, Number(e.target.value) || 1)))
              }
              className="h-7 rounded border border-border bg-bg px-2"
              data-testid="batch-limit"
            />
          </label>
        </div>
        <label className="flex items-center gap-2 text-fg-muted">
          <input
            type="checkbox"
            checked={background}
            onChange={(e) => {
              setBackground(e.target.checked);
              if (!e.target.checked) setLimit((l) => Math.min(l, SYNC_LIMIT));
            }}
            disabled={running}
            data-testid="batch-background"
          />
          Run in the background (up to {BACKGROUND_LIMIT} traces; the job keeps running if you close
          this dialog, and <span className="mono">shadow jobs list</span> shows it)
        </label>
        {job && (
          <div className="flex items-center gap-3" data-testid="batch-job">
            <span className="mono text-fg-faint">{job.id}</span>
            <Badge
              tone={
                job.status === "failed"
                  ? "err"
                  : job.status === "completed"
                    ? "ok"
                    : job.status === "cancelled"
                      ? "muted"
                      : "warn"
              }
            >
              {job.status}
            </Badge>
            <progress
              className="h-2 flex-1"
              max={Math.max(1, job.progress.total)}
              value={job.progress.done}
              aria-label="Batch progress"
            />
            <span className="tabular" data-testid="batch-job-progress">
              {job.progress.done}/{job.progress.total}
            </span>
            {(job.status === "queued" || job.status === "running") && (
              <Button size="xs" variant="ghost" onClick={cancelJob} data-testid="cancel-batch-job">
                Cancel job
              </Button>
            )}
          </div>
        )}
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
          <Button variant="ghost" onClick={onClose} disabled={running && !background}>
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
