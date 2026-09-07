"use client";

import { api } from "@/lib/api";
import { classNames } from "@/lib/format";
import type { Branch, JsonValue, Override, ShadowEvent } from "@shadow/schemas";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Badge, Button, Dialog, Spinner } from "../ui/primitives";

type Kind = Override["kind"];

interface Row {
  key: number;
  kind: Kind;
  op: "set" | "remove";
  field: string;
  value: string;
  message: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  traceId: string;
  branch: Branch;
  branches: Branch[];
  event: ShadowEvent;
  onCreated: (branch: Branch, comparisonId: string | null) => Promise<void> | void;
}

function parseValue(text: string): JsonValue {
  const trimmed = text.trim();
  if (trimmed === "") return "";
  try {
    return JSON.parse(trimmed) as JsonValue;
  } catch {
    return text;
  }
}

type Parsed = { ok: true; override: Override } | { ok: false; error: string };

function bad(error: string): Parsed {
  return { ok: false, error };
}

function good(override: Override): Parsed {
  return { ok: true, override };
}

function toOverride(row: Row): Parsed {
  switch (row.kind) {
    case "context":
      if (!row.field.trim()) return bad("context key is required");
      return good(
        row.op === "remove"
          ? { kind: "context", op: "remove", key: row.field.trim() }
          : { kind: "context", op: "set", key: row.field.trim(), value: parseValue(row.value) },
      );
    case "state":
      if (!row.field.startsWith("/"))
        return bad("state path must be a JSON pointer starting with /");
      return good(
        row.op === "remove"
          ? { kind: "state", op: "remove", path: row.field }
          : { kind: "state", op: "set", path: row.field, value: parseValue(row.value) },
      );
    case "tool_result":
      if (!row.field.trim()) return bad("tool name is required");
      return good({
        kind: "tool_result",
        tool: row.field.trim(),
        occurrence: 1,
        result: parseValue(row.value),
      });
    case "tool_error":
      if (!row.field.trim()) return bad("tool name is required");
      return good({
        kind: "tool_error",
        tool: row.field.trim(),
        occurrence: 1,
        error: {
          message: row.message.trim() || "injected failure",
          code: "injected",
          retryable: false,
        },
      });
    case "policy": {
      if (!row.field.trim()) return bad("policy id is required");
      const config = parseValue(row.value);
      if (config === null || typeof config !== "object" || Array.isArray(config))
        return bad("policy config must be a JSON object");
      return good({ kind: "policy", policy: row.field.trim(), config });
    }
  }
}

let rowKey = 0;

/** Fork editor: choose typed overrides and run the deterministic counterfactual. */
export function ForkDialog({ open, onClose, traceId, branch, branches, event, onCreated }: Props) {
  const [rows, setRows] = useState<Row[]>([]);
  const [name, setName] = useState(
    () => `fork-${branches.filter((b) => b.parentBranchId !== null).length + 1}`,
  );
  const [phase, setPhase] = useState<"idle" | "forking" | "replaying" | "comparing">("idle");
  const [error, setError] = useState<string | null>(null);

  const before = useQuery({
    queryKey: ["state-before", branch.id, event.sequence],
    queryFn: () => api.branchState(branch.id, event.sequence - 1),
    enabled: open,
  });

  const contextEntries = useMemo(() => Object.entries(before.data?.context ?? {}), [before.data]);
  const toolName = event.eventType.startsWith("tool.") ? event.name : null;

  const addRow = (partial: Partial<Row>) =>
    setRows((r) => [
      ...r,
      { key: rowKey++, kind: "context", op: "set", field: "", value: "", message: "", ...partial },
    ]);
  const updateRow = (key: number, patch: Partial<Row>) =>
    setRows((r) => r.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  const removeRow = (key: number) => setRows((r) => r.filter((row) => row.key !== key));

  const parsed = rows.map(toOverride);
  const problems = parsed.filter((p) => !p.ok);
  const overrides = parsed.flatMap((p) => (p.ok ? [p.override] : []));
  const canRun = rows.length > 0 && problems.length === 0 && phase === "idle";

  const run = async () => {
    setError(null);
    try {
      setPhase("forking");
      const created = await api.createFork(traceId, {
        forkEventId: event.id,
        parentBranchId: branch.id,
        name: name.trim() || undefined,
        overrides,
      });
      setPhase("replaying");
      const replayed = await api.replay(created.branch.id);
      if (replayed.replay.status !== "completed") {
        setError(
          `Replay failed: ${replayed.replay.error ?? "unknown error"}. The branch was kept so you can inspect the replay.failed event.`,
        );
        setPhase("idle");
        await onCreated(replayed.branch, null);
        return;
      }
      setPhase("comparing");
      const root = branches.find((b) => b.parentBranchId === null) ?? branch;
      const comparison = await api.createComparison(root.id, created.branch.id);
      await onCreated(replayed.branch, comparison.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("idle");
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Fork from here"
      testId="fork-dialog"
      width="max-w-3xl"
    >
      <div className="space-y-4 p-4 text-[12px]">
        <div className="rounded border border-border bg-bg p-2">
          <p className="text-fg-muted">Rewind to just before</p>
          <p className="mono">
            #{event.sequence} {event.eventType} <span className="font-semibold">{event.name}</span>
            <span className="text-fg-faint"> on branch {branch.name}</span>
          </p>
          <p className="mt-1 text-fg-muted">
            Events before this point are inherited; this event and everything after it are
            re-executed deterministically with your overrides applied. Selecting a response or
            policy outcome forks at the call that produced it.
          </p>
        </div>

        <div className="grid grid-cols-[1fr_auto] items-center gap-2">
          <label htmlFor="fork-name" className="text-fg-muted">
            Branch name
          </label>
          <input
            id="fork-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mono h-7 w-56 rounded border border-border bg-bg px-2"
            data-testid="fork-name"
          />
        </div>

        <section>
          <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
            Context at this point (click a key to override it)
          </h3>
          {before.isLoading ? (
            <Spinner label="Loading context" />
          ) : contextEntries.length === 0 ? (
            <p className="text-fg-faint">No context values yet.</p>
          ) : (
            <div className="flex flex-wrap gap-1">
              {contextEntries.map(([key, value]) => (
                <button
                  key={key}
                  type="button"
                  className="mono rounded border border-border bg-panel px-1.5 py-0.5 hover:bg-hover"
                  onClick={() =>
                    addRow({
                      kind: "context",
                      field: key,
                      value: typeof value === "string" ? value : JSON.stringify(value),
                    })
                  }
                  data-testid={`context-chip-${key}`}
                  title={`Override ${key}`}
                >
                  {key} = {typeof value === "string" ? value : JSON.stringify(value)}
                </button>
              ))}
            </div>
          )}
        </section>

        <section>
          <div className="mb-1 flex items-center justify-between">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
              Overrides
            </h3>
            <div className="flex gap-1">
              <Button
                size="xs"
                onClick={() => addRow({ kind: "context" })}
                data-testid="add-context-override"
              >
                + Context
              </Button>
              <Button size="xs" onClick={() => addRow({ kind: "state", field: "/" })}>
                + State
              </Button>
              <Button
                size="xs"
                onClick={() => addRow({ kind: "tool_result", field: toolName ?? "" })}
                data-testid="add-tool-result-override"
              >
                + Tool result
              </Button>
              <Button
                size="xs"
                onClick={() =>
                  addRow({ kind: "tool_error", field: toolName ?? "", message: "timeout" })
                }
              >
                + Tool error
              </Button>
              <Button size="xs" onClick={() => addRow({ kind: "policy", value: "{}" })}>
                + Policy
              </Button>
            </div>
          </div>
          {rows.length === 0 ? (
            <p className="rounded border border-dashed border-border p-3 text-center text-fg-faint">
              Add at least one override to describe the counterfactual.
            </p>
          ) : (
            <ul className="space-y-1" data-testid="override-rows">
              {rows.map((row, i) => {
                const problem = parsed[i];
                return (
                  <li
                    key={row.key}
                    className={classNames(
                      "grid grid-cols-[110px_80px_1fr_1fr_auto] items-center gap-1 rounded border border-border bg-bg p-1",
                    )}
                    data-testid="override-row"
                  >
                    <select
                      value={row.kind}
                      onChange={(e) => updateRow(row.key, { kind: e.target.value as Kind })}
                      className="h-7 rounded border border-border bg-panel px-1"
                      aria-label="Override kind"
                    >
                      <option value="context">context</option>
                      <option value="state">state</option>
                      <option value="tool_result">tool result</option>
                      <option value="tool_error">tool error</option>
                      <option value="policy">policy</option>
                    </select>
                    {row.kind === "context" || row.kind === "state" ? (
                      <select
                        value={row.op}
                        onChange={(e) =>
                          updateRow(row.key, { op: e.target.value as "set" | "remove" })
                        }
                        className="h-7 rounded border border-border bg-panel px-1"
                        aria-label="Operation"
                      >
                        <option value="set">set</option>
                        <option value="remove">remove</option>
                      </select>
                    ) : (
                      <span className="text-center text-fg-faint">
                        {row.kind === "policy" ? "config" : "next call"}
                      </span>
                    )}
                    <input
                      value={row.field}
                      onChange={(e) => updateRow(row.key, { field: e.target.value })}
                      placeholder={
                        row.kind === "state"
                          ? "/path/to/field"
                          : row.kind === "policy"
                            ? "policy id"
                            : row.kind === "context"
                              ? "key"
                              : "tool name"
                      }
                      className="mono h-7 rounded border border-border bg-panel px-2"
                      aria-label="Field"
                      data-testid="override-field"
                    />
                    {row.kind === "tool_error" ? (
                      <input
                        value={row.message}
                        onChange={(e) => updateRow(row.key, { message: e.target.value })}
                        placeholder="error message"
                        className="mono h-7 rounded border border-border bg-panel px-2"
                        aria-label="Error message"
                      />
                    ) : row.op === "remove" && (row.kind === "context" || row.kind === "state") ? (
                      <span className="text-fg-faint">(removed)</span>
                    ) : (
                      <input
                        value={row.value}
                        onChange={(e) => updateRow(row.key, { value: e.target.value })}
                        placeholder={row.kind === "policy" ? '{"limit": 100}' : "JSON or text"}
                        className="mono h-7 rounded border border-border bg-panel px-2"
                        aria-label="Value"
                        data-testid="override-value"
                      />
                    )}
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => removeRow(row.key)}
                      aria-label="Remove override"
                    >
                      ×
                    </Button>
                    {problem && !problem.ok && (
                      <p className="col-span-5 text-err">{problem.error}</p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <p className="mt-1 text-fg-faint">
            Values are parsed as JSON when possible (100 → number, &quot;enterprise&quot; → string,{" "}
            {`{"a":1}`} → object).
          </p>
        </section>

        {error && (
          <p className="rounded border border-err/40 bg-err-bg p-2 text-err" role="alert">
            {error}
          </p>
        )}

        <div className="flex items-center justify-between border-t border-border pt-3">
          <span className="text-fg-muted">
            {overrides.length} override{overrides.length === 1 ? "" : "s"} · deterministic replay{" "}
            <Badge tone="muted">no external calls</Badge>
          </span>
          <div className="flex items-center gap-2">
            {phase !== "idle" && (
              <Spinner
                label={
                  phase === "forking"
                    ? "Creating branch"
                    : phase === "replaying"
                      ? "Replaying"
                      : "Comparing"
                }
              />
            )}
            <Button variant="ghost" onClick={onClose} disabled={phase !== "idle"}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={run}
              disabled={!canRun}
              data-testid="run-counterfactual"
            >
              Run counterfactual
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
