import { describe, expect, it } from "vitest";
import { z } from "zod";
import { emptyBranchMetrics, isJsonObject, pageSchema, traceSchema } from "../src/index.js";

describe("schema helpers", () => {
  it("isJsonObject distinguishes plain objects from arrays and primitives", () => {
    expect(isJsonObject({ a: 1 })).toBe(true);
    expect(isJsonObject([])).toBe(false);
    expect(isJsonObject(null)).toBe(false);
    expect(isJsonObject("x")).toBe(false);
  });

  it("emptyBranchMetrics returns zeroed metrics and is used as the trace default", () => {
    const metrics = emptyBranchMetrics();
    expect(metrics).toMatchObject({
      eventCount: 0,
      toolCalls: 0,
      totalEstimatedCost: 0,
      currency: "USD",
    });
    const trace = traceSchema.parse({
      id: "trc_1",
      projectId: "prj_1",
      agentId: "agt_1",
      rootBranchId: "br_1",
      name: "t",
      status: "running",
      schemaVersion: "1.0",
      startedAt: "2026-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(trace.metrics).toEqual(metrics);
    expect(trace.branchCount).toBe(1);
  });

  it("pageSchema wraps an item schema with a cursor", () => {
    const page = pageSchema(z.object({ id: z.string() }));
    expect(page.parse({ items: [{ id: "a" }], nextCursor: null }).items).toHaveLength(1);
    expect(page.safeParse({ items: [{ id: 1 }], nextCursor: null }).success).toBe(false);
    expect(page.safeParse({ items: [] }).success).toBe(false);
  });
});
