import { describe, expect, it } from "vitest";
import { bucketLabel, formatMetric, niceTicks } from "./trend";

describe("niceTicks", () => {
  it("steps by 1, 2 or 5 times a power of ten from zero past the maximum", () => {
    expect(niceTicks(7)).toEqual([0, 2, 4, 6, 8]);
    expect(niceTicks(100)).toEqual([0, 50, 100]);
    expect(niceTicks(0.0048)).toEqual([0, 0.002, 0.004, 0.006]);
    expect(niceTicks(1234)).toEqual([0, 500, 1000, 1500]);
  });

  it("keeps integer metrics on whole numbers and handles an empty series", () => {
    expect(niceTicks(2, 4, true)).toEqual([0, 1, 2]);
    expect(niceTicks(0)).toEqual([0, 1]);
  });
});

describe("formatting", () => {
  it("labels buckets in UTC", () => {
    expect(bucketLabel("2026-09-01T00:00:00.000Z", "day")).toBe("Sep 1");
    expect(bucketLabel("2026-09-01T09:00:00.000Z", "hour")).toBe("Sep 1 09:00");
  });

  it("formats values by metric", () => {
    expect(formatMetric(null, "p95DurationMs")).toBe("–");
    expect(formatMetric(1200, "traces")).toBe("1,200");
    expect(formatMetric(0.0049, "totalEstimatedCost")).toMatch(/^\$0\.0049/);
  });
});
