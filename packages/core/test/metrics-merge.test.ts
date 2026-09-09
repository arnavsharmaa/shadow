import { emptyBranchMetrics } from "@shadow/schemas";
import { describe, expect, it } from "vitest";
import { aggregateMetrics, mergeMetrics, recordExecution } from "../src/index.js";
import { refundAgentDefinition } from "../../testkit/src/scenarios/refund-agent.js";

async function refundEvents() {
  const recorded = await recordExecution({
    definition: refundAgentDefinition,
    input: {
      customerId: "cus_1001",
      channel: "email",
      message: "Refund my $480 headphones (ord_5001).",
    },
    traceId: "trc_metrics",
    branchId: "br_metrics",
    traceName: "metrics",
    seed: "metrics",
    startAt: "2026-09-01T09:00:00.000Z",
  });
  return recorded.events;
}

describe("mergeMetrics", () => {
  it("merging batch aggregates equals aggregating the whole timeline", async () => {
    const events = await refundEvents();
    const full = aggregateMetrics(events);
    expect(full.firstTimestamp).toBe(events[0]?.timestamp);
    expect(full.lastTimestamp).toBe(events[events.length - 1]?.timestamp);

    const batches = [events.slice(0, 7), events.slice(7, 30), events.slice(30)];
    let merged = emptyBranchMetrics();
    for (const batch of batches) merged = mergeMetrics(merged, aggregateMetrics(batch));
    expect(merged).toEqual(full);
  });

  it("is order independent and handles empty sides", () => {
    const a = {
      ...emptyBranchMetrics(),
      eventCount: 2,
      toolCalls: 1,
      estimatedToolCost: 0.1,
      totalEstimatedCost: 0.1,
      firstTimestamp: "2026-01-01T00:00:01.000Z",
      lastTimestamp: "2026-01-01T00:00:03.000Z",
      durationMs: 2000,
    };
    const b = {
      ...emptyBranchMetrics(),
      eventCount: 3,
      modelCalls: 1,
      inputTokens: 5,
      outputTokens: 2,
      totalTokens: 7,
      estimatedModelCost: 0.2,
      totalEstimatedCost: 0.2,
      firstTimestamp: "2026-01-01T00:00:00.000Z",
      lastTimestamp: "2026-01-01T00:00:02.000Z",
      durationMs: 2000,
    };
    const ab = mergeMetrics(a, b);
    expect(ab).toEqual(mergeMetrics(b, a));
    expect(ab).toMatchObject({
      eventCount: 5,
      toolCalls: 1,
      modelCalls: 1,
      totalTokens: 7,
      totalEstimatedCost: 0.3,
      firstTimestamp: "2026-01-01T00:00:00.000Z",
      lastTimestamp: "2026-01-01T00:00:03.000Z",
      durationMs: 3000,
    });
    expect(mergeMetrics(emptyBranchMetrics(), a)).toEqual(a);
    expect(mergeMetrics(a, emptyBranchMetrics())).toEqual(a);
  });
});
