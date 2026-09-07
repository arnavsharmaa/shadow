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
  return m;
}
