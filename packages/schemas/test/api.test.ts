import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  batchCounterfactualBodySchema,
  collectionTracesBodySchema,
  createAlertRuleBodySchema,
  createCollectionBodySchema,
  createShareBodySchema,
  eventListQuerySchema,
  exportTracesBodySchema,
  importAnthropicBodySchema,
  pageSchema,
  tagTracesBodySchema,
  updateAlertRuleBodySchema,
  updateCollectionBodySchema,
  updateTraceBodySchema,
} from "../src/index.js";

describe("pageSchema", () => {
  it("wraps an item schema in a cursor page", () => {
    const page = pageSchema(z.object({ id: z.string() }));
    expect(page.parse({ items: [{ id: "a" }], nextCursor: null })).toEqual({
      items: [{ id: "a" }],
      nextCursor: null,
    });
    expect(page.safeParse({ items: [{ id: 1 }], nextCursor: null }).success).toBe(false);
  });
});

describe("eventListQuerySchema", () => {
  it("reads `inherited` from booleans and query strings, defaulting to true", () => {
    expect(eventListQuerySchema.parse({}).inherited).toBe(true);
    expect(eventListQuerySchema.parse({ inherited: "false" }).inherited).toBe(false);
    expect(eventListQuerySchema.parse({ inherited: "true" }).inherited).toBe(true);
    expect(eventListQuerySchema.parse({ inherited: false }).inherited).toBe(false);
    expect(eventListQuerySchema.safeParse({ inherited: "maybe" }).success).toBe(false);
  });
});

describe("updateTraceBodySchema", () => {
  it("needs at least one field", () => {
    expect(updateTraceBodySchema.safeParse({}).success).toBe(false);
    expect(updateTraceBodySchema.parse({ addTags: ["triaged"] })).toEqual({
      addTags: ["triaged"],
    });
    expect(updateTraceBodySchema.parse({ metadata: { owner: null } })).toEqual({
      metadata: { owner: null },
    });
  });
});

describe("batchCounterfactualBodySchema", () => {
  const base = {
    agent: "refund-agent",
    at: { name: "refund_order" },
    overrides: [{ kind: "context", op: "set", key: "refundLimit", value: 100 }],
  };

  it("defaults to a synchronous batch of 20 tool-request forks", () => {
    expect(batchCounterfactualBodySchema.parse(base)).toMatchObject({
      limit: 20,
      background: false,
      at: { eventType: "tool.request", name: "refund_order" },
    });
  });

  it("caps synchronous batches at 50 and background ones at 500", () => {
    const sync = batchCounterfactualBodySchema.safeParse({ ...base, limit: 51 });
    expect(sync.success).toBe(false);
    expect(sync.error?.issues[0]).toMatchObject({ path: ["limit"] });
    expect(sync.error?.issues[0]?.message).toContain("background: true");
    expect(
      batchCounterfactualBodySchema.parse({ ...base, limit: 500, background: true }).limit,
    ).toBe(500);
    expect(
      batchCounterfactualBodySchema.safeParse({ ...base, limit: 501, background: true }).success,
    ).toBe(false);
  });
});

describe("collection bodies", () => {
  it("keeps names URL-friendly and trims them", () => {
    expect(createCollectionBodySchema.parse({ name: "  incident 2026-09-01 " })).toEqual({
      name: "incident 2026-09-01",
      traceIds: [],
    });
    for (const name of ["a/b", "what?", "", " ", "-leading-dash"]) {
      expect(createCollectionBodySchema.safeParse({ name }).success, name).toBe(false);
    }
  });

  it("rejects empty updates and allows clearing the description", () => {
    expect(updateCollectionBodySchema.safeParse({}).success).toBe(false);
    expect(updateCollectionBodySchema.parse({ description: null })).toEqual({ description: null });
    expect(updateCollectionBodySchema.parse({ name: "renamed" })).toEqual({ name: "renamed" });
  });
});

describe("bodies that pick traces by id, by a selection, or both", () => {
  const bodies = [
    ["export", exportTracesBodySchema, {}],
    ["collect", collectionTracesBodySchema, {}],
    ["tag", tagTracesBodySchema, { add: ["triage"] }],
  ] as const;

  it("take ids, the trace list's filters, or both", () => {
    for (const [name, schema, extra] of bodies) {
      expect(schema.parse({ ...extra, traceIds: ["trc_1"] }), name).toMatchObject({
        traceIds: ["trc_1"],
      });
      // Filters alone: the ids default to none, and query-string spellings are understood.
      const selected = schema.parse({
        ...extra,
        query: { agent: "refund-agent", outcome: "policy_violation", minCost: "0.5" },
      });
      expect(selected.traceIds, name).toEqual([]);
      expect(selected.query, name).toEqual({
        agent: "refund-agent",
        outcome: "policy_violation",
        minCost: 0.5,
      });
      // An empty selection is a selection: every trace, up to the route's cap.
      expect(schema.safeParse({ ...extra, query: {} }).success, name).toBe(true);
      expect(
        schema.safeParse({ ...extra, traceIds: ["trc_1"], query: { status: "failed" } }).success,
        name,
      ).toBe(true);
    }
  });

  it("need one of the two, and refuse what the list would refuse", () => {
    for (const [name, schema, extra] of bodies) {
      const neither = schema.safeParse({ ...extra });
      expect(neither.success, name).toBe(false);
      expect(neither.error?.issues[0]?.message, name).toBe("traceIds or query is required");
      expect(schema.safeParse({ ...extra, traceIds: [] }).success, name).toBe(false);
      expect(schema.safeParse({ ...extra, query: { status: "exploded" } }).success, name).toBe(
        false,
      );
      // Paging and sorting are not part of a selection.
      expect(schema.parse({ ...extra, query: { limit: 5, sort: "name" } }).query, name).toEqual({});
      expect(
        schema.safeParse({
          ...extra,
          traceIds: Array.from({ length: 501 }, (_, i) => `trc_${i}`),
        }).success,
        name,
      ).toBe(false);
    }
  });

  it("tagging also needs something to add or remove", () => {
    const idle = tagTracesBodySchema.safeParse({ traceIds: ["trc_1"] });
    expect(idle.success).toBe(false);
    expect(idle.error?.issues[0]?.message).toBe("add or remove is required");
    expect(tagTracesBodySchema.parse({ traceIds: ["trc_1"], remove: ["stale"] })).toMatchObject({
      add: [],
      remove: ["stale"],
    });
  });
});

describe("alert rule bodies", () => {
  it("applies the window, volume and enabled defaults", () => {
    expect(
      createAlertRuleBodySchema.parse({
        name: " refund failures ",
        metric: "failure_rate",
        threshold: 0.5,
      }),
    ).toEqual({
      name: "refund failures",
      metric: "failure_rate",
      threshold: 0.5,
      mode: "threshold",
      baselineWindows: 7,
      windowMinutes: 60,
      minTraces: 1,
      keepFiringMinutes: 0,
      enabled: true,
    });
    expect(
      createAlertRuleBodySchema.parse({
        name: "cost spike",
        metric: "total_cost",
        threshold: 3,
        mode: "baseline",
        baselineWindows: 14,
      }),
    ).toMatchObject({ mode: "baseline", baselineWindows: 14 });
    expect(
      createAlertRuleBodySchema.safeParse({
        name: "x",
        metric: "total_cost",
        threshold: 3,
        mode: "seasonal",
      }).success,
    ).toBe(false);
    expect(
      createAlertRuleBodySchema.safeParse({ name: "x", metric: "vibes", threshold: 1 }).success,
    ).toBe(false);
    expect(
      createAlertRuleBodySchema.safeParse({
        name: "x",
        metric: "tool_errors",
        threshold: 1,
        windowMinutes: 43_201,
      }).success,
    ).toBe(false);
  });

  it("rejects empty updates", () => {
    expect(updateAlertRuleBodySchema.safeParse({}).success).toBe(false);
    expect(updateAlertRuleBodySchema.parse({ enabled: false })).toEqual({ enabled: false });
  });
});

describe("createShareBodySchema", () => {
  it("defaults to seven days and caps the lifetime at thirty", () => {
    expect(createShareBodySchema.parse({})).toEqual({ expiresInHours: 168 });
    expect(createShareBodySchema.safeParse({ expiresInHours: 721 }).success).toBe(false);
    expect(createShareBodySchema.safeParse({ expiresInHours: 0 }).success).toBe(false);
  });
});

describe("importAnthropicBodySchema", () => {
  it("defaults the project, agent and tags and keeps content blocks verbatim", () => {
    const parsed = importAnthropicBodySchema.parse({
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_1", name: "t", input: { a: 1 }, extra: true }],
        },
      ],
      responses: [
        { stop_reason: "tool_use", usage: { input_tokens: 3, output_tokens: 4, speed: "fast" } },
      ],
    });
    expect(parsed).toMatchObject({ agent: "claude-agent", tags: [] });
    expect(parsed.project).toBeUndefined();
    expect(parsed.messages[1]?.content).toEqual([
      { type: "tool_use", id: "toolu_1", name: "t", input: { a: 1 }, extra: true },
    ]);
    expect(parsed.responses?.[0]?.usage).toMatchObject({ speed: "fast" });
  });

  it("rejects empty histories, unknown roles and blocks without a type", () => {
    expect(importAnthropicBodySchema.safeParse({ messages: [] }).success).toBe(false);
    expect(
      importAnthropicBodySchema.safeParse({ messages: [{ role: "tool", content: "x" }] }).success,
    ).toBe(false);
    expect(
      importAnthropicBodySchema.safeParse({
        messages: [{ role: "user", content: [{ text: "x" }] }],
      }).success,
    ).toBe(false);
  });
});
