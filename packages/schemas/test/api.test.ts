import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  batchCounterfactualBodySchema,
  createAlertRuleBodySchema,
  createCollectionBodySchema,
  createShareBodySchema,
  eventListQuerySchema,
  pageSchema,
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
      windowMinutes: 60,
      minTraces: 1,
      enabled: true,
    });
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
