import { describe, expect, it } from "vitest";
import { normalizeViewQuery, saveViewBodySchema } from "../src/index.js";

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
