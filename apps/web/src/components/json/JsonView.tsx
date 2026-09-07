"use client";

import { classNames } from "@/lib/format";
import type { JsonValue } from "@shadow/schemas";
import { useCallback, useMemo, useState } from "react";
import { Button } from "../ui/primitives";

interface JsonViewProps {
  value: JsonValue | undefined;
  /** Depth up to which nodes start expanded. */
  defaultExpandDepth?: number;
  className?: string;
  label?: string;
  testId?: string;
}

/** Collapsible, syntax-coloured JSON tree with copy and raw toggle. */
export function JsonView({
  value,
  defaultExpandDepth = 2,
  className,
  label,
  testId,
}: JsonViewProps) {
  const [raw, setRaw] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = useMemo(
    () => (value === undefined ? "undefined" : JSON.stringify(value, null, 2)),
    [value],
  );

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  }, [text]);

  return (
    <div
      className={classNames("rounded border border-border bg-bg", className)}
      data-testid={testId}
    >
      <div className="flex h-7 items-center justify-between border-b border-border px-2 text-[11px] text-fg-muted">
        <span className="truncate">
          {label ?? "JSON"}
          {value !== undefined && ` · ${text.length.toLocaleString()} chars`}
        </span>
        <span className="flex items-center gap-1">
          <Button variant="ghost" size="xs" onClick={() => setRaw((r) => !r)} aria-pressed={raw}>
            {raw ? "Tree" : "Raw"}
          </Button>
          <Button variant="ghost" size="xs" onClick={copy} aria-label="Copy JSON to clipboard">
            {copied ? "Copied" : "Copy"}
          </Button>
        </span>
      </div>
      <div className="mono max-h-[60vh] overflow-auto p-2 leading-5">
        {value === undefined ? (
          <span className="json-null">undefined</span>
        ) : raw ? (
          <pre className="whitespace-pre-wrap break-words">{text}</pre>
        ) : (
          <JsonNode value={value} depth={0} expandDepth={defaultExpandDepth} />
        )}
      </div>
    </div>
  );
}

function JsonNode({
  value,
  depth,
  expandDepth,
  name,
}: {
  value: JsonValue;
  depth: number;
  expandDepth: number;
  name?: string;
}) {
  const [open, setOpen] = useState(depth < expandDepth);
  const isContainer = value !== null && typeof value === "object";
  const keyLabel =
    name !== undefined ? <span className="json-key">{JSON.stringify(name)}: </span> : null;

  if (!isContainer) {
    return (
      <div className="pl-[calc(var(--d)*12px)]" style={{ "--d": depth } as React.CSSProperties}>
        {keyLabel}
        <Primitive value={value} />
      </div>
    );
  }

  const entries: [string | undefined, JsonValue][] = Array.isArray(value)
    ? value.map((v) => [undefined, v] as [string | undefined, JsonValue])
    : Object.entries(value as Record<string, JsonValue>);
  const brackets = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
  const summary = Array.isArray(value) ? `${entries.length} items` : `${entries.length} keys`;

  return (
    <div>
      <div className="pl-[calc(var(--d)*12px)]" style={{ "--d": depth } as React.CSSProperties}>
        <button
          type="button"
          className="inline-flex cursor-pointer select-none items-center gap-1 rounded hover:bg-hover"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={`${open ? "Collapse" : "Expand"} ${name ?? "value"}`}
        >
          <span className="inline-block w-3 text-center text-fg-faint">
            {entries.length === 0 ? "" : open ? "▾" : "▸"}
          </span>
          {keyLabel}
          <span className="text-fg-muted">{brackets[0]}</span>
          {!open && <span className="text-fg-faint"> {summary} </span>}
          {!open && <span className="text-fg-muted">{brackets[1]}</span>}
        </button>
      </div>
      {open && (
        <>
          {entries.map(([k, v], i) => (
            <JsonNode
              key={k ?? i}
              value={v}
              depth={depth + 1}
              expandDepth={expandDepth}
              name={k ?? String(i)}
            />
          ))}
          <div
            className="pl-[calc(var(--d)*12px+12px)] text-fg-muted"
            style={{ "--d": depth } as React.CSSProperties}
          >
            {brackets[1]}
          </div>
        </>
      )}
    </div>
  );
}

function Primitive({ value }: { value: JsonValue }) {
  if (value === null) return <span className="json-null">null</span>;
  if (typeof value === "string")
    return <span className="json-string break-words">{JSON.stringify(value)}</span>;
  if (typeof value === "number") return <span className="json-number">{String(value)}</span>;
  if (typeof value === "boolean") return <span className="json-bool">{String(value)}</span>;
  return <span>{JSON.stringify(value)}</span>;
}

/** Inline one-line rendering for tables. */
export function inlineJson(value: JsonValue | undefined, max = 80): string {
  if (value === undefined) return "–";
  const text = JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
