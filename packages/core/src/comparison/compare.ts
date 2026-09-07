import type {
  AlignedStep,
  Branch,
  ComparisonResult,
  Delta,
  EventRef,
  FieldDiff,
  FirstDivergence,
  JsonObject,
  JsonValue,
  Outcome,
  Override,
  PolicyDecision,
  ShadowEvent,
  ToolCallDiff,
  ToolCallSummary,
} from "@shadow/schemas";
import { sharedPrefixSequence } from "../branches/lineage.js";
import { deepEqual } from "../json.js";
import { aggregateMetrics } from "../metrics/aggregate.js";
import { isSetupEvent } from "../runtime/history.js";
import { diffJson, formatDiffPath } from "../state/diff.js";
import { reconstructState } from "../state/reconstruct.js";

export interface CompareSide {
  branch: Branch;
  /** Effective lineage of the branch, sorted by sequence. */
  events: readonly ShadowEvent[];
}

export interface CompareOptions {
  overrides?: Override[];
  /** Above this product of suffix lengths a windowed greedy alignment is used. */
  maxDpCells?: number;
}

export function toEventRef(event: ShadowEvent): EventRef {
  return {
    id: event.id,
    branchId: event.branchId,
    sequence: event.sequence,
    eventType: event.eventType,
    name: event.name,
    timestamp: event.timestamp,
    durationMs: event.durationMs ?? null,
  };
}

function signature(event: ShadowEvent): string {
  return `${event.eventType} ${event.name}`;
}

function prefixed(prefix: string, path: string): string {
  return path ? `${prefix}.${formatDiffPath(path)}` : prefix;
}

/** Field-level differences that matter for divergence (ids/timestamps ignored). */
export function diffEventFields(a: ShadowEvent, b: ShadowEvent): FieldDiff[] {
  const fields: FieldDiff[] = [];
  if (a.eventType !== b.eventType) {
    fields.push({ path: "eventType", before: a.eventType, after: b.eventType });
  }
  if (a.name !== b.name) fields.push({ path: "name", before: a.name, after: b.name });
  for (const entry of diffJson(a.output, b.output)) {
    fields.push({ path: prefixed("output", entry.path), before: entry.before, after: entry.after });
  }
  for (const entry of diffJson(a.input, b.input)) {
    fields.push({ path: prefixed("input", entry.path), before: entry.before, after: entry.after });
  }
  if (a.severity !== b.severity) {
    fields.push({ path: "severity", before: a.severity, after: b.severity });
  }
  return fields;
}

type Pair = { a: number | null; b: number | null };

/** Longest-common-subsequence alignment over event signatures. */
function alignLcs(a: readonly ShadowEvent[], b: readonly ShadowEvent[]): Pair[] {
  const n = a.length;
  const m = b.length;
  const sa = a.map(signature);
  const sb = b.map(signature);
  // dp[i][j] = LCS length of a[i..] and b[j..]
  const width = m + 1;
  const dp = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] =
        sa[i] === sb[j]
          ? (dp[(i + 1) * width + j + 1] as number) + 1
          : Math.max(dp[(i + 1) * width + j] as number, dp[i * width + j + 1] as number);
    }
  }
  const pairs: Pair[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (sa[i] === sb[j]) {
      pairs.push({ a: i, b: j });
      i++;
      j++;
    } else if ((dp[(i + 1) * width + j] as number) >= (dp[i * width + j + 1] as number)) {
      pairs.push({ a: i, b: null });
      i++;
    } else {
      pairs.push({ a: null, b: j });
      j++;
    }
  }
  while (i < n) pairs.push({ a: i++, b: null });
  while (j < m) pairs.push({ a: null, b: j++ });
  return pairs;
}

/** Greedy alignment with a lookahead window, for very large suffixes. */
function alignGreedy(a: readonly ShadowEvent[], b: readonly ShadowEvent[], window = 64): Pair[] {
  const pairs: Pair[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const sa = signature(a[i] as ShadowEvent);
    const sb = signature(b[j] as ShadowEvent);
    if (sa === sb) {
      pairs.push({ a: i, b: j });
      i++;
      j++;
      continue;
    }
    let foundB = -1;
    for (let k = 1; k <= window && j + k < b.length; k++) {
      if (signature(b[j + k] as ShadowEvent) === sa) {
        foundB = k;
        break;
      }
    }
    let foundA = -1;
    for (let k = 1; k <= window && i + k < a.length; k++) {
      if (signature(a[i + k] as ShadowEvent) === sb) {
        foundA = k;
        break;
      }
    }
    if (foundB !== -1 && (foundA === -1 || foundB <= foundA)) {
      for (let k = 0; k < foundB; k++) pairs.push({ a: null, b: j + k });
      j += foundB;
    } else if (foundA !== -1) {
      for (let k = 0; k < foundA; k++) pairs.push({ a: i + k, b: null });
      i += foundA;
    } else {
      pairs.push({ a: i, b: null });
      pairs.push({ a: null, b: j });
      i++;
      j++;
    }
  }
  while (i < a.length) pairs.push({ a: i++, b: null });
  while (j < b.length) pairs.push({ a: null, b: j++ });
  return pairs;
}

function delta(base: number, target: number): Delta {
  const d = target - base;
  return { base, target, delta: d, percent: base === 0 ? null : d / base };
}

export function deriveOutcome(events: readonly ShadowEvent[]): Outcome | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i] as ShadowEvent;
    if (event.eventType === "trace.completed" || event.eventType === "trace.failed") {
      const output = event.output as JsonObject | undefined;
      const outcome = output?.outcome;
      if (outcome && typeof outcome === "object" && !Array.isArray(outcome)) {
        return outcome as Outcome;
      }
      const error = output?.error as JsonObject | undefined;
      return {
        kind: event.eventType === "trace.failed" ? "error" : "completed",
        label: String(error?.message ?? event.name),
      };
    }
  }
  return null;
}

export function summariseToolCalls(events: readonly ShadowEvent[]): ToolCallSummary[] {
  const byParent = new Map<string, ShadowEvent[]>();
  for (const e of events) {
    if (e.parentEventId) {
      byParent.set(e.parentEventId, [...(byParent.get(e.parentEventId) ?? []), e]);
    }
  }
  const out: ToolCallSummary[] = [];
  for (const e of events) {
    if (e.eventType !== "tool.request") continue;
    const input = e.input as JsonObject | undefined;
    const children = byParent.get(e.id) ?? [];
    const response = children.find((c) => c.eventType === "tool.response");
    const error = children.find((c) => c.eventType === "tool.error");
    const summary: ToolCallSummary = {
      eventId: e.id,
      sequence: e.sequence,
      tool: String(input?.tool ?? e.name),
      arguments: input?.arguments,
      status: error ? "error" : "ok",
      durationMs: response?.durationMs ?? error?.durationMs ?? null,
    };
    if (response) summary.result = (response.output as JsonObject | undefined)?.result;
    if (error) summary.error = (error.output as JsonObject | undefined)?.error;
    out.push(summary);
  }
  return out;
}

function occurrenceMap(list: ToolCallSummary[]): Map<string, ToolCallSummary> {
  const counts = new Map<string, number>();
  const map = new Map<string, ToolCallSummary>();
  for (const t of list) {
    const n = (counts.get(t.tool) ?? 0) + 1;
    counts.set(t.tool, n);
    map.set(`${t.tool}#${n}`, t);
  }
  return map;
}

function diffToolCalls(base: ToolCallSummary[], target: ToolCallSummary[]): ToolCallDiff[] {
  const diffs: ToolCallDiff[] = [];
  const b = occurrenceMap(base);
  const t = occurrenceMap(target);
  for (const [k, call] of b) {
    const other = t.get(k);
    if (!other) {
      diffs.push({ tool: call.tool, kind: "removed", base: call, target: null, fields: [] });
      continue;
    }
    const fields: FieldDiff[] = [];
    for (const entry of diffJson(call.arguments, other.arguments)) {
      fields.push({
        path: prefixed("arguments", entry.path),
        before: entry.before,
        after: entry.after,
      });
    }
    const argFields = fields.length;
    for (const entry of diffJson(call.result, other.result)) {
      fields.push({
        path: prefixed("result", entry.path),
        before: entry.before,
        after: entry.after,
      });
    }
    if (call.status !== other.status) {
      diffs.push({ tool: call.tool, kind: "status", base: call, target: other, fields });
    } else if (argFields > 0) {
      diffs.push({ tool: call.tool, kind: "arguments", base: call, target: other, fields });
    } else if (fields.length > 0) {
      diffs.push({ tool: call.tool, kind: "result", base: call, target: other, fields });
    }
  }
  for (const [k, call] of t) {
    if (!b.has(k))
      diffs.push({ tool: call.tool, kind: "added", base: null, target: call, fields: [] });
  }
  return diffs;
}

interface PolicyDecisionSummary {
  eventId: string;
  sequence: number;
  policy: string;
  decision: PolicyDecision;
  reason?: string;
}

function policyDecisions(events: readonly ShadowEvent[]) {
  const decisions: PolicyDecisionSummary[] = [];
  const counts = { allow: 0, deny: 0, approval_required: 0 };
  for (const e of events) {
    if (e.eventType !== "policy.evaluated") continue;
    const output = e.output as JsonObject | undefined;
    const decision = output?.decision as PolicyDecision | undefined;
    if (!decision || !(decision in counts)) continue;
    counts[decision]++;
    decisions.push({
      eventId: e.id,
      sequence: e.sequence,
      policy: String(output?.policy ?? e.name),
      decision,
      ...(typeof output?.reason === "string" ? { reason: output.reason } : {}),
    });
  }
  return { decisions, counts };
}

function short(value: JsonValue | undefined): string {
  if (value === undefined) return "(absent)";
  const s = JSON.stringify(value);
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
}

function describeDivergence(step: AlignedStep): string {
  const base = step.base;
  const target = step.target;
  if (step.kind === "added" && target) {
    return `${target.eventType} '${target.name}' only happens in the counterfactual`;
  }
  if (step.kind === "removed" && base) {
    return `${base.eventType} '${base.name}' only happens in the original`;
  }
  if (base && target) {
    const first = step.fields[0];
    if (first) {
      return `${base.eventType} '${base.name}': ${first.path} changed from ${short(first.before)} to ${short(first.after)}`;
    }
    return `${base.eventType} '${base.name}' differs`;
  }
  return "executions diverge";
}

function divergenceReason(step: AlignedStep): FirstDivergence["reason"] {
  if (step.kind === "added") return "event_added";
  if (step.kind === "removed") return "event_removed";
  if (step.fields.some((f) => f.path === "eventType")) return "type_changed";
  if (step.fields.some((f) => f.path === "name")) return "name_changed";
  if (step.fields.some((f) => f.path.startsWith("output"))) return "output_changed";
  return "input_changed";
}

/**
 * Compare two branch lineages: shared prefix, aligned suffixes, first
 * divergence, tool/context/state diffs and metric deltas.
 */
export function compareBranches(
  base: CompareSide,
  target: CompareSide,
  options: CompareOptions = {},
): ComparisonResult {
  const sharedUntil = sharedPrefixSequence(base.events, target.events);
  const sharedCount = base.events.findIndex((e) => e.sequence > sharedUntil);
  const sharedEvents = sharedCount === -1 ? base.events : base.events.slice(0, sharedCount);
  const baseSuffix = base.events.filter((e) => e.sequence > sharedUntil && !isSetupEvent(e));
  const targetAll = target.events.filter((e) => e.sequence > sharedUntil);
  const targetSetup = targetAll.filter(isSetupEvent);
  const targetSuffix = targetAll.filter((e) => !isSetupEvent(e));

  const maxCells = options.maxDpCells ?? 4_000_000;
  const pairs =
    baseSuffix.length * targetSuffix.length <= maxCells
      ? alignLcs(baseSuffix, targetSuffix)
      : alignGreedy(baseSuffix, targetSuffix);

  const steps: AlignedStep[] = [];
  for (const e of sharedEvents) {
    steps.push({
      index: steps.length,
      kind: "shared",
      base: toEventRef(e),
      target: toEventRef(e),
      fields: [],
    });
  }
  for (const e of targetSetup) {
    steps.push({
      index: steps.length,
      kind: "override",
      base: null,
      target: toEventRef(e),
      fields: [],
    });
  }

  const added: EventRef[] = [];
  const removed: EventRef[] = [];
  const modified: ComparisonResult["modifiedEvents"] = [];
  let firstDivergence: FirstDivergence | null = null;
  for (const pair of pairs) {
    const a = pair.a === null ? null : (baseSuffix[pair.a] as ShadowEvent);
    const b = pair.b === null ? null : (targetSuffix[pair.b] as ShadowEvent);
    let step: AlignedStep;
    if (a && b) {
      const fields = diffEventFields(a, b);
      step = {
        index: steps.length,
        kind: fields.length === 0 ? "same" : "modified",
        base: toEventRef(a),
        target: toEventRef(b),
        fields,
      };
      if (fields.length > 0) {
        modified.push({ base: step.base as EventRef, target: step.target as EventRef, fields });
      }
    } else if (a) {
      step = {
        index: steps.length,
        kind: "removed",
        base: toEventRef(a),
        target: null,
        fields: [],
      };
      removed.push(step.base as EventRef);
    } else {
      step = {
        index: steps.length,
        kind: "added",
        base: null,
        target: toEventRef(b as ShadowEvent),
        fields: [],
      };
      added.push(step.target as EventRef);
    }
    steps.push(step);
    if (!firstDivergence && step.kind !== "same") {
      const anchor = (step.base ?? step.target) as EventRef;
      firstDivergence = {
        stepIndex: step.index,
        sequence: anchor.sequence,
        reason: divergenceReason(step),
        summary: describeDivergence(step),
        base: step.base,
        target: step.target,
        fields: step.fields,
      };
    }
  }

  const baseMetrics = aggregateMetrics(base.events);
  const targetMetrics = aggregateMetrics(target.events);
  const baseState = reconstructState(base.events);
  const targetState = reconstructState(target.events);
  const baseTools = summariseToolCalls(base.events);
  const targetTools = summariseToolCalls(target.events);
  const baseOutcome = base.branch.outcome ?? deriveOutcome(base.events);
  const targetOutcome = target.branch.outcome ?? deriveOutcome(target.events);
  const basePolicy = policyDecisions(base.events);
  const targetPolicy = policyDecisions(target.events);

  return {
    base: {
      branchId: base.branch.id,
      name: base.branch.name,
      metrics: baseMetrics,
      outcome: baseOutcome,
      eventCount: base.events.length,
    },
    target: {
      branchId: target.branch.id,
      name: target.branch.name,
      metrics: targetMetrics,
      outcome: targetOutcome,
      eventCount: target.events.length,
    },
    sharedUntilSequence: sharedUntil,
    overrides: options.overrides ?? [],
    firstDivergence,
    steps,
    addedEvents: added,
    removedEvents: removed,
    modifiedEvents: modified,
    toolCalls: {
      base: baseTools,
      target: targetTools,
      diffs: diffToolCalls(baseTools, targetTools),
    },
    context: { diff: diffJson(baseState.context, targetState.context) },
    state: { diff: diffJson(baseState.state, targetState.state) },
    metrics: {
      totalTokens: delta(baseMetrics.totalTokens, targetMetrics.totalTokens),
      inputTokens: delta(baseMetrics.inputTokens, targetMetrics.inputTokens),
      outputTokens: delta(baseMetrics.outputTokens, targetMetrics.outputTokens),
      totalEstimatedCost: delta(baseMetrics.totalEstimatedCost, targetMetrics.totalEstimatedCost),
      durationMs: delta(baseMetrics.durationMs, targetMetrics.durationMs),
      toolCalls: delta(baseMetrics.toolCalls, targetMetrics.toolCalls),
      modelCalls: delta(baseMetrics.modelCalls, targetMetrics.modelCalls),
      eventCount: delta(base.events.length, target.events.length),
    },
    outcome: {
      base: baseOutcome,
      target: targetOutcome,
      changed: !deepEqual(baseOutcome, targetOutcome),
    },
    policy: {
      base: basePolicy.counts,
      target: targetPolicy.counts,
      baseDecisions: basePolicy.decisions,
      targetDecisions: targetPolicy.decisions,
      changed: !deepEqual(
        basePolicy.decisions.map((d) => [d.policy, d.decision]),
        targetPolicy.decisions.map((d) => [d.policy, d.decision]),
      ),
    },
  };
}
