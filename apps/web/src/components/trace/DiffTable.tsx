"use client";

import { classNames } from "@/lib/format";
import { formatDiffPath } from "@shadow/core";
import type { DiffEntry, FieldDiff, JsonValue } from "@shadow/schemas";
import { inlineJson } from "../json/JsonView";

const opClass: Record<DiffEntry["op"], string> = {
  added: "bg-diff-add",
  removed: "bg-diff-del",
  changed: "bg-diff-mod",
};

/** Renders leaf-level differences; only meaningful differences are listed. */
export function DiffTable({
  entries,
  emptyLabel = "No differences",
  testId,
  labels = ["Before", "After"],
}: {
  entries: DiffEntry[];
  emptyLabel?: string;
  testId?: string;
  labels?: [string, string];
}) {
  if (entries.length === 0) return <p className="p-2 text-[12px] text-fg-faint">{emptyLabel}</p>;
  return (
    <table className="w-full border-collapse text-[12px]" data-testid={testId}>
      <thead className="text-left text-[11px] uppercase tracking-wide text-fg-muted">
        <tr>
          <th className="border-b border-border px-2 py-1">Path</th>
          <th className="border-b border-border px-2 py-1">{labels[0]}</th>
          <th className="border-b border-border px-2 py-1">{labels[1]}</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((entry, i) => (
          <tr
            key={`${entry.path}-${i}`}
            className={classNames("border-b border-border align-top", opClass[entry.op])}
            data-diff-op={entry.op}
          >
            <td className="mono px-2 py-1 whitespace-nowrap">
              {formatDiffPath(entry.path)} <span className="text-fg-faint">({entry.op})</span>
            </td>
            <td className="mono px-2 py-1 break-all">
              {entry.op === "added" ? (
                <span className="text-fg-faint">–</span>
              ) : (
                inlineJson(entry.before, 160)
              )}
            </td>
            <td className="mono px-2 py-1 break-all">
              {entry.op === "removed" ? (
                <span className="text-fg-faint">–</span>
              ) : (
                inlineJson(entry.after, 160)
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function FieldDiffTable({
  fields,
  labels = ["Original", "Counterfactual"],
  testId,
}: {
  fields: FieldDiff[];
  labels?: [string, string];
  testId?: string;
}) {
  if (fields.length === 0) return <p className="p-2 text-[12px] text-fg-faint">Identical</p>;
  return (
    <table className="w-full border-collapse text-[12px]" data-testid={testId}>
      <thead className="text-left text-[11px] uppercase tracking-wide text-fg-muted">
        <tr>
          <th className="border-b border-border px-2 py-1">Field</th>
          <th className="border-b border-border px-2 py-1">{labels[0]}</th>
          <th className="border-b border-border px-2 py-1">{labels[1]}</th>
        </tr>
      </thead>
      <tbody>
        {fields.map((f, i) => (
          <tr key={`${f.path}-${i}`} className="border-b border-border align-top">
            <td className="mono px-2 py-1 whitespace-nowrap">{f.path}</td>
            <td className="mono bg-diff-del px-2 py-1 break-all">{render(f.before)}</td>
            <td className="mono bg-diff-add px-2 py-1 break-all">{render(f.after)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function render(value: JsonValue | undefined) {
  return value === undefined ? (
    <span className="text-fg-faint">(absent)</span>
  ) : (
    inlineJson(value, 200)
  );
}
