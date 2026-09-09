import type { BranchMetrics, ShadowEvent } from "@shadow/schemas";
import { emptyBranchMetrics } from "@shadow/schemas";
import { roundMoney } from "./pricing.js";

/** Aggregate usage and estimated cost over an effective event timeline. */
export function aggregateMetrics(events: readonly ShadowEvent[]): BranchMetrics {
  const m = emptyBranchMetrics();
  let first: number | null = null;
  let last: number | null = null;
  for (const event of events) {
    m.eventCount++;
    // Closing events (responses, completions) are stamped at the end of their
    // span, so wall-clock duration is simply the timestamp range.
    const ts = Date.parse(event.timestamp);
    if (!Number.isNaN(ts)) {
      if (first === null || ts < first) first = ts;
      if (last === null || ts > last) last = ts;
    }
    switch (event.eventType) {
      case "model.request":
        m.modelCalls++;
        break;
      case "tool.request":
        m.toolCalls++;
        break;
      case "tool.error":
        m.toolErrors++;
        break;
      case "policy.evaluated":
        m.policyEvaluations++;
        break;
      default:
        break;
    }
    if (event.tokenUsage) {
      m.inputTokens += event.tokenUsage.inputTokens;
      m.outputTokens += event.tokenUsage.outputTokens;
      m.totalTokens += event.tokenUsage.totalTokens;
    }
    if (event.estimatedCost) {
      if (event.eventType.startsWith("model.")) m.estimatedModelCost += event.estimatedCost.amount;
      else m.estimatedToolCost += event.estimatedCost.amount;
      if (event.estimatedCost.currency) m.currency = event.estimatedCost.currency;
    }
  }
  m.estimatedModelCost = roundMoney(m.estimatedModelCost);
  m.estimatedToolCost = roundMoney(m.estimatedToolCost);
  m.totalEstimatedCost = roundMoney(m.estimatedModelCost + m.estimatedToolCost);
  m.durationMs = first !== null && last !== null ? Math.max(0, last - first) : 0;
  m.firstTimestamp = first !== null ? new Date(first).toISOString() : null;
  m.lastTimestamp = last !== null ? new Date(last).toISOString() : null;
  return m;
}

/**
 * Combine metrics of two disjoint event sets (for example a branch's stored
 * metrics and a newly ingested batch). Counts, tokens and costs add up; the
 * wall-clock duration is derived from the combined timestamp bounds, so the
 * result equals `aggregateMetrics` over the union of both sets.
 */
export function mergeMetrics(a: BranchMetrics, b: BranchMetrics): BranchMetrics {
  const first = earliest(a.firstTimestamp, b.firstTimestamp);
  const last = latest(a.lastTimestamp, b.lastTimestamp);
  const estimatedModelCost = roundMoney(a.estimatedModelCost + b.estimatedModelCost);
  const estimatedToolCost = roundMoney(a.estimatedToolCost + b.estimatedToolCost);
  return {
    eventCount: a.eventCount + b.eventCount,
    modelCalls: a.modelCalls + b.modelCalls,
    toolCalls: a.toolCalls + b.toolCalls,
    toolErrors: a.toolErrors + b.toolErrors,
    policyEvaluations: a.policyEvaluations + b.policyEvaluations,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    estimatedModelCost,
    estimatedToolCost,
    totalEstimatedCost: roundMoney(estimatedModelCost + estimatedToolCost),
    durationMs: first && last ? Math.max(0, Date.parse(last) - Date.parse(first)) : 0,
    currency: b.eventCount > 0 ? b.currency : a.currency,
    firstTimestamp: first,
    lastTimestamp: last,
  };
}

function earliest(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

function latest(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}
