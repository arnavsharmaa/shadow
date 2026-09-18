import { VirtualClock } from "@shadow/core";
import type { Comparison, Trace } from "@shadow/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, ingestRefundScenario, json, type TestApp } from "../helpers.js";

interface Page {
  items: Comparison[];
  nextCursor: string | null;
}

let t: TestApp;
let traceId: string;
const created: string[] = [];

beforeAll(async () => {
  t = await createTestApp({ clock: new VirtualClock("2026-09-18T10:00:00.000Z") });
  const base = await ingestRefundScenario(t, "trc_cmp_paging");
  traceId = base.traceId;
  for (let i = 0; i < 5; i++) {
    const other = json<Trace>(
      await t.app.inject({
        method: "POST",
        url: "/api/v1/traces",
        payload: { project: "p", agent: "a", name: `other-${i}` },
      }),
    );
    const comparison = json<Comparison>(
      await t.app.inject({
        method: "POST",
        url: "/api/v1/comparisons",
        payload: { baseBranchId: base.rootBranchId, targetBranchId: other.rootBranchId },
      }),
    );
    created.push(comparison.id);
    // Two comparisons share a timestamp so the id tie-break is exercised.
    if (i !== 1) t.services.clock.advance(1000);
  }
});

afterAll(async () => {
  await t.close();
});

describe("comparison pagination", () => {
  it("pages newest first with a keyset cursor and yields each comparison once", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const suffix: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
      const url: string = `/api/v1/comparisons?traceId=${traceId}&limit=2${suffix}`;
      const page: Page = json<Page>(await t.app.inject({ method: "GET", url }));
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((c) => c.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(seen).toEqual([...created].reverse());
  });

  it("returns everything in one page when it fits and rejects bad cursors", async () => {
    const all = json<Page>(
      await t.app.inject({ method: "GET", url: `/api/v1/comparisons?traceId=${traceId}` }),
    );
    expect(all.items).toHaveLength(5);
    expect(all.nextCursor).toBeNull();
    const bad = await t.app.inject({ method: "GET", url: "/api/v1/comparisons?cursor=nope" });
    expect(bad.statusCode).toBe(400);
  });
});
