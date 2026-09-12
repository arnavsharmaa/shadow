import type { Branch, Fork, ShadowEvent, Trace } from "@shadow/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestApp,
  ingestEvent,
  json,
  listAllEvents,
  must,
  type ErrorEnvelope,
  type TestApp,
} from "../helpers.js";

interface Page {
  items: ShadowEvent[];
  nextCursor: string | null;
}

const TOTAL = 25;

describe("event pagination", () => {
  let t: TestApp;
  let trace: Trace;
  let fork: { branch: Branch; fork: Fork };

  async function page(query: string): Promise<Page> {
    const response = await t.app.inject({
      method: "GET",
      url: `/api/v1/traces/${trace.id}/events?${query}`,
    });
    if (response.statusCode !== 200) throw new Error(response.body);
    return json<Page>(response);
  }

  beforeAll(async () => {
    t = await createTestApp();
    trace = json<Trace>(
      await t.app.inject({
        method: "POST",
        url: "/api/v1/traces",
        payload: { project: "p", agent: "a", name: "paging" },
      }),
    );
    const events = Array.from({ length: TOTAL }, (_, i) =>
      i % 5 === 0
        ? ingestEvent("tool.request", `tool_${i}`, { input: { i } })
        : ingestEvent("agent.note", `note_${i}`, { input: { i } }),
    );
    const ingested = await t.app.inject({
      method: "POST",
      url: `/api/v1/traces/${trace.id}/events`,
      payload: { events },
    });
    if (ingested.statusCode !== 201) throw new Error(ingested.body);
    const all = await listAllEvents(t, trace.id);
    const forkEvent = must(all.find((e) => e.sequence === 10));
    const forked = await t.app.inject({
      method: "POST",
      url: `/api/v1/traces/${trace.id}/forks`,
      payload: { forkEventId: forkEvent.id, overrides: [] },
    });
    if (forked.statusCode !== 201) throw new Error(forked.body);
    fork = json<{ branch: Branch; fork: Fork }>(forked);
  });

  afterAll(async () => {
    await t.close();
  });

  it("returns pages with a nextCursor and yields every event exactly once in order", async () => {
    const first = await page("limit=10");
    expect(first.items).toHaveLength(10);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(first.items.map((e) => e.sequence)).toEqual(Array.from({ length: 10 }, (_, i) => i));

    const seen: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const current: Page = await page(
        `limit=10${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      pages++;
      seen.push(...current.items.map((e) => e.sequence));
      cursor = current.nextCursor;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toEqual(Array.from({ length: TOTAL }, (_, i) => i));
    expect(new Set(seen).size).toBe(TOTAL);
  });

  it("omits nextCursor when the page holds the last event", async () => {
    const exact = await page(`limit=${TOTAL}`);
    expect(exact.items).toHaveLength(TOTAL);
    expect(exact.nextCursor).toBeNull();
    const oversized = await page("limit=1000");
    expect(oversized.items).toHaveLength(TOTAL);
    expect(oversized.nextCursor).toBeNull();
  });

  it("defaults to 200 items per page", async () => {
    const response = await t.app.inject({
      method: "GET",
      url: `/api/v1/traces/${trace.id}/events`,
    });
    expect(response.statusCode).toBe(200);
    expect(json<Page>(response).items).toHaveLength(TOTAL);
  });

  it("rejects invalid limits and cursors", async () => {
    for (const query of ["limit=0", "limit=1001", "limit=abc"]) {
      const response = await t.app.inject({
        method: "GET",
        url: `/api/v1/traces/${trace.id}/events?${query}`,
      });
      expect(response.statusCode, query).toBe(400);
      expect(json<ErrorEnvelope>(response).error.code).toBe("validation_error");
    }
    for (const cursor of [
      "%25%25%25",
      "bm90LWpzb24",
      Buffer.from(JSON.stringify({ s: "1" })).toString("base64url"),
    ]) {
      const response = await t.app.inject({
        method: "GET",
        url: `/api/v1/traces/${trace.id}/events?cursor=${cursor}`,
      });
      expect(response.statusCode, cursor).toBe(400);
      const body = json<ErrorEnvelope>(response);
      expect(body.error.code).toBe("bad_request");
      expect(body.error.message).toBe("invalid cursor");
      expect(response.headers["x-request-id"]).toBe(body.error.requestId);
    }
  });

  it("filters by eventType, also across pages", async () => {
    const tools = await page("eventType=tool.request");
    expect(tools.items).toHaveLength(5);
    expect(tools.items.every((e) => e.eventType === "tool.request")).toBe(true);
    expect(tools.items.map((e) => e.sequence)).toEqual([0, 5, 10, 15, 20]);

    const collected: number[] = [];
    let cursor: string | null = null;
    do {
      const current: Page = await page(
        `eventType=tool.request&limit=2${cursor ? `&cursor=${cursor}` : ""}`,
      );
      expect(current.items.length).toBeLessThanOrEqual(2);
      collected.push(...current.items.map((e) => e.sequence));
      cursor = current.nextCursor;
    } while (cursor);
    expect(collected).toEqual([0, 5, 10, 15, 20]);

    const none = await page("eventType=model.request");
    expect(none).toEqual({ items: [], nextCursor: null });
  });

  it("filters by name, severity and free text", async () => {
    const all = await page("limit=1000");
    const sample = must(
      all.items.find((e) => e.eventType === "tool.request"),
      "tool request",
    );
    const byName = await page(`limit=1000&name=${encodeURIComponent(sample.name)}`);
    expect(byName.items.length).toBeGreaterThan(0);
    expect(byName.items.every((e) => e.name === sample.name)).toBe(true);

    const byText = await page(`limit=1000&q=${encodeURIComponent("TOOL.")}`);
    expect(byText.items.length).toBeGreaterThan(0);
    expect(byText.items.every((e) => e.eventType.startsWith("tool."))).toBe(true);
    const escaped = await page("limit=1000&q=%25");
    expect(escaped.items).toHaveLength(0);

    const errors = await page("limit=1000&severity=error");
    expect(errors.items.every((e) => e.severity === "error")).toBe(true);
    const invalid = await t.app.inject({
      method: "GET",
      url: `/api/v1/traces/${trace.id}/events?severity=loud`,
    });
    expect(invalid.statusCode).toBe(400);
  });

  it("returns only own events for a fork when inherited=false", async () => {
    expect(fork.branch.forkSequence).toBe(9);
    const own = await page(`branchId=${fork.branch.id}&inherited=false`);
    expect(own.items).toHaveLength(1);
    expect(own.items[0]).toMatchObject({
      eventType: "fork.created",
      sequence: 10,
      branchId: fork.branch.id,
      name: "fork-1",
    });

    const inherited = await page(`branchId=${fork.branch.id}`);
    expect(inherited.items).toHaveLength(11);
    expect(inherited.items.slice(0, 10).every((e) => e.branchId === trace.rootBranchId)).toBe(true);
    expect(inherited.items[10]?.eventType).toBe("fork.created");
    expect(inherited.items.map((e) => e.sequence)).toEqual(Array.from({ length: 11 }, (_, i) => i));

    const explicit = await page(`branchId=${fork.branch.id}&inherited=true`);
    expect(explicit.items.map((e) => e.id)).toEqual(inherited.items.map((e) => e.id));

    const paged = await listAllEvents(t, trace.id, { branchId: fork.branch.id, limit: 4 });
    expect(paged.map((e) => e.id)).toEqual(inherited.items.map((e) => e.id));
  });

  it("serves the same lineage from the branch events endpoint", async () => {
    const response = await t.app.inject({
      method: "GET",
      url: `/api/v1/branches/${fork.branch.id}/events?limit=4`,
    });
    expect(response.statusCode).toBe(200);
    const first = json<Page>(response);
    expect(first.items).toHaveLength(4);
    expect(first.nextCursor).toEqual(expect.any(String));
    const filtered = json<Page>(
      await t.app.inject({
        method: "GET",
        url: `/api/v1/branches/${fork.branch.id}/events?eventType=fork.created`,
      }),
    );
    expect(filtered.items).toHaveLength(1);
    expect(
      (await t.app.inject({ method: "GET", url: "/api/v1/branches/br_missing/events" })).statusCode,
    ).toBe(404);
  });

  it("rejects branches that belong to another trace", async () => {
    const other = json<Trace>(
      await t.app.inject({
        method: "POST",
        url: "/api/v1/traces",
        payload: { project: "p", agent: "a", name: "other" },
      }),
    );
    const response = await t.app.inject({
      method: "GET",
      url: `/api/v1/traces/${other.id}/events?branchId=${trace.rootBranchId}`,
    });
    expect(response.statusCode).toBe(404);
    expect(
      (
        await t.app.inject({
          method: "GET",
          url: `/api/v1/traces/${trace.id}/events?branchId=br_missing`,
        })
      ).statusCode,
    ).toBe(404);
  });

  it("fetches single events by id", async () => {
    const [first] = (await page("limit=1")).items;
    const response = await t.app.inject({
      method: "GET",
      url: `/api/v1/traces/${trace.id}/events/${first?.id ?? ""}`,
    });
    expect(response.statusCode).toBe(200);
    expect(json<ShadowEvent>(response)).toEqual(first);
    expect(
      (await t.app.inject({ method: "GET", url: `/api/v1/traces/${trace.id}/events/evt_missing` }))
        .statusCode,
    ).toBe(404);
  });
});
