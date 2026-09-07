import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { likeSearchProvider } from "../../src/services/search.js";

const agent = { slug: "refund-agent", name: "Refund Agent" };
const project = { slug: "support-agent", name: "Support Agent" };

function tokens(text: string): Set<string> {
  return new Set(text.split(" "));
}

describe("likeSearchProvider.buildSearchText", () => {
  it("indexes ids, names, tags, agent and project", () => {
    const text = likeSearchProvider.buildSearchText({
      trace: {
        id: "trc_abc",
        name: "Refund Request: Headphones",
        tags: ["Refund", "policy"],
        metadata: {},
      },
      agent,
      project,
      events: [],
    });
    const set = tokens(text);
    expect(set.has("trc_abc")).toBe(true);
    expect(set.has("refund_request:_headphones")).toBe(true);
    expect(set.has("refund")).toBe(true);
    expect(set.has("policy")).toBe(true);
    expect(set.has("refund-agent")).toBe(true);
    expect(set.has("refund_agent")).toBe(true);
    expect(set.has("support-agent")).toBe(true);
    expect(set.has("support_agent")).toBe(true);
    expect(text).toBe(text.toLowerCase());
  });

  it("indexes metadata keys and nested values", () => {
    const text = likeSearchProvider.buildSearchText({
      trace: {
        id: "trc_1",
        name: "t",
        tags: [],
        metadata: {
          customerId: "cus_1001",
          nested: { ticket: "TCK-9", count: 3, ok: true, none: null },
          list: ["alpha", 7],
        },
      },
      agent,
      project,
      events: [],
    });
    const set = tokens(text);
    for (const expected of [
      "customerid",
      "cus_1001",
      "nested",
      "ticket",
      "tck-9",
      "count",
      "3",
      "ok",
      "true",
      "list",
      "alpha",
      "7",
    ]) {
      expect(set.has(expected), expected).toBe(true);
    }
    expect(set.has("null")).toBe(false);
  });

  it("adds event ids, names and tool:<name> tokens for tool requests", () => {
    const text = likeSearchProvider.buildSearchText({
      trace: { id: "trc_1", name: "t", tags: [], metadata: {} },
      agent,
      project,
      events: [
        { id: "evt_1", eventType: "tool.request", name: "refund_order" },
        { id: "evt_2", eventType: "tool.response", name: "refund_order" },
        { id: "evt_3", eventType: "model.request", name: "plan" },
      ],
    });
    const set = tokens(text);
    expect(set.has("evt_1")).toBe(true);
    expect(set.has("evt_2")).toBe(true);
    expect(set.has("evt_3")).toBe(true);
    expect(set.has("refund_order")).toBe(true);
    expect(set.has("tool:refund_order")).toBe(true);
    expect(set.has("tool:plan")).toBe(false);
    expect([...set].filter((t) => t === "tool:refund_order")).toHaveLength(1);
  });

  it("preserves previous text and de-duplicates tokens", () => {
    const first = likeSearchProvider.buildSearchText({
      trace: { id: "trc_1", name: "t", tags: [], metadata: {} },
      agent,
      project,
      events: [{ id: "evt_1", eventType: "tool.request", name: "read_customer" }],
    });
    const second = likeSearchProvider.buildSearchText({
      trace: { id: "trc_1", name: "t", tags: [], metadata: {} },
      agent,
      project,
      events: [{ id: "evt_2", eventType: "tool.request", name: "refund_order" }],
      previous: first,
    });
    const set = tokens(second);
    expect(set.has("tool:read_customer")).toBe(true);
    expect(set.has("tool:refund_order")).toBe(true);
    expect(set.has("evt_1")).toBe(true);
    expect(second.split(" ")).toHaveLength(set.size);
  });

  it("ignores blank values and normalises whitespace", () => {
    const text = likeSearchProvider.buildSearchText({
      trace: { id: "trc_1", name: "  Multi   word  name ", tags: ["", "  "], metadata: {} },
      agent,
      project,
      events: [],
    });
    const set = tokens(text);
    expect(set.has("multi_word_name")).toBe(true);
    expect(set.has("")).toBe(false);
  });

  it("caps the text at 64KiB", () => {
    const huge = Array.from({ length: 5000 }, (_, i) => `token_${i}_${"x".repeat(20)}`);
    const text = likeSearchProvider.buildSearchText({
      trace: { id: "trc_1", name: "t", tags: huge, metadata: {} },
      agent,
      project,
      events: [],
    });
    expect(text.length).toBe(64 * 1024);
    expect(text.startsWith("trc_1 ")).toBe(true);
  });
});

describe("likeSearchProvider.filter", () => {
  const dialect = new PgDialect();

  it("builds a case-insensitive LIKE predicate", () => {
    const query = dialect.sqlToQuery(likeSearchProvider.filter("  Cus_1001 "));
    expect(query.sql).toMatch(/ilike/i);
    expect(query.params).toEqual(["%cus\\_1001%"]);
  });

  it("escapes LIKE wildcards in the query", () => {
    const query = dialect.sqlToQuery(likeSearchProvider.filter("50%_a\\b"));
    expect(query.params).toEqual(["%50\\%\\_a\\\\b%"]);
  });
});
