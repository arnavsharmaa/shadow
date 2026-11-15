import { describe, expect, it } from "vitest";
import {
  SAVED_VIEW_KEYS,
  normalizeViewQuery,
  saveViewBodySchema,
  type SavedViewKey,
} from "../src/index.js";

describe("normalizeViewQuery", () => {
  it("drops paging and sorts keys", () => {
    expect(normalizeViewQuery("?status=failed&cursor=abc&agent=refund-agent&limit=5")).toBe(
      "agent=refund-agent&status=failed",
    );
    expect(normalizeViewQuery("")).toBe("");
  });

  it("serialises exactly like URLSearchParams so the web app can match views", () => {
    for (const query of [
      "q=late+refund&status=failed",
      "q=it's (almost) ~done!&tag=a*b",
      "q=caf%C3%A9%20%26%20more&sort=name&order=asc",
      "from=2026-09-01T00:00:00.000Z&minCost=0.01",
    ]) {
      const expected = new URLSearchParams(query);
      expected.sort();
      expect(normalizeViewQuery(query), query).toBe(expected.toString());
    }
  });

  it("accepts every filter it says a view may carry", () => {
    // One valid value per key; a key added to SAVED_VIEW_KEYS has to be given one here.
    const samples: Record<SavedViewKey, string> = {
      project: "support-agent",
      agent: "refund-agent",
      status: "failed",
      outcome: "policy_violation",
      tag: "refund",
      tool: "refund_order",
      toolError: "refund_order",
      q: "cus_1001",
      from: "2026-09-01T00:00:00.000Z",
      to: "2026-09-08T00:00:00.000Z",
      minCost: "0.01",
      minDurationMs: "1500",
      collection: "incident-42",
      meta: "attempt=3",
      sort: "totalEstimatedCost",
      order: "asc",
    };
    expect(Object.keys(samples).sort()).toEqual([...SAVED_VIEW_KEYS].sort());
    for (const key of SAVED_VIEW_KEYS) {
      const query = new URLSearchParams({ [key]: samples[key] }).toString();
      expect(normalizeViewQuery(query), key).toBe(query);
    }
    const everything = new URLSearchParams(samples);
    everything.sort();
    expect(normalizeViewQuery(everything.toString())).toBe(everything.toString());
    // The explorer's "Failed tool" filter used to make a view unsaveable.
    expect(
      saveViewBodySchema.safeParse({ name: "blocked refunds", query: "toolError=refund_order" })
        .success,
    ).toBe(true);
  });

  it("rejects unknown keys, duplicates, bad values and broken encodings", () => {
    expect(normalizeViewQuery("unknown=1")).toBeNull();
    expect(normalizeViewQuery("status=failed&status=completed")).toBeNull();
    expect(normalizeViewQuery("status=exploded")).toBeNull();
    expect(normalizeViewQuery("q=%E0%A4%A")).toBeNull();
    expect(saveViewBodySchema.safeParse({ name: "x", query: "sort=nope" }).success).toBe(false);
    expect(saveViewBodySchema.parse({ name: " x ", query: "status=failed" })).toEqual({
      name: "x",
      query: "status=failed",
    });
  });
});
