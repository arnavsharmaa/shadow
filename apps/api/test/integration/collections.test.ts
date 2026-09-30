import type { AuditEntry, Collection, SavedView, TraceSummary } from "@shadow/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, json, type TestApp } from "../helpers.js";

let t: TestApp;
const REFUND = "trc_demo_refund_violation";

interface Created {
  collection: Collection;
  added: string[];
  missing: string[];
}

async function traceIds(query: string): Promise<string[]> {
  const page = json<{ items: TraceSummary[]; total: number }>(
    await t.app.inject({ url: `/api/v1/traces?${query}` }),
  );
  return page.items.map((i) => i.id);
}

beforeAll(async () => {
  t = await createTestApp();
  await t.seed();
});

afterAll(async () => {
  await t.close();
});

describe("trace collections", () => {
  it("groups traces, filters the trace list and survives duplicates and unknown ids", async () => {
    const all = await traceIds("limit=50");
    const [first, second] = all.filter((id) => id !== REFUND);
    const created = await t.app.inject({
      method: "POST",
      url: "/api/v1/collections",
      headers: { "x-shadow-actor": "arnav" },
      payload: {
        name: "incident 2026-09-01",
        description: "refund limit incident",
        traceIds: [REFUND, REFUND, "trc_missing"],
      },
    });
    expect(created.statusCode).toBe(201);
    const body = json<Created>(created);
    expect(body.collection).toMatchObject({
      name: "incident 2026-09-01",
      description: "refund limit incident",
      traceCount: 1,
    });
    expect(body.collection.id).toMatch(/^col_/);
    expect(body).toMatchObject({ added: [REFUND], missing: ["trc_missing"] });

    const added = await t.app.inject({
      method: "POST",
      url: "/api/v1/collections/incident%202026-09-01/traces",
      payload: { traceIds: [REFUND, first, second] },
    });
    expect(added.statusCode).toBe(200);
    expect(json<Created>(added)).toMatchObject({
      added: [first, second],
      missing: [],
      collection: { traceCount: 3 },
    });

    expect((await traceIds("collection=incident%202026-09-01")).sort()).toEqual(
      [REFUND, first, second].sort(),
    );
    // The collection filter combines with the others and unknown names match nothing.
    expect(
      await traceIds("collection=incident%202026-09-01&status=failed&agent=refund-agent"),
    ).toEqual([REFUND]);
    expect(await traceIds("collection=nope")).toEqual([]);

    const containing = json<{ items: Collection[] }>(
      await t.app.inject({ url: `/api/v1/collections?traceId=${REFUND}` }),
    );
    expect(containing.items.map((c) => c.name)).toEqual(["incident 2026-09-01"]);

    const removed = await t.app.inject({
      method: "DELETE",
      url: `/api/v1/collections/${body.collection.id}/traces/${second}`,
    });
    expect(json<Collection>(removed).traceCount).toBe(2);
    const again = await t.app.inject({
      method: "DELETE",
      url: `/api/v1/collections/${body.collection.id}/traces/${second}`,
    });
    expect(again.statusCode).toBe(404);

    // Deleting a trace removes it from its collections.
    await t.app.inject({ method: "DELETE", url: `/api/v1/traces/${first}` });
    expect(
      json<Collection>(await t.app.inject({ url: `/api/v1/collections/${body.collection.id}` }))
        .traceCount,
    ).toBe(1);
  });

  it("renames, validates and deletes collections without touching traces", async () => {
    const duplicate = await t.app.inject({
      method: "POST",
      url: "/api/v1/collections",
      payload: { name: "incident 2026-09-01" },
    });
    expect(duplicate.statusCode).toBe(409);
    const badName = await t.app.inject({
      method: "POST",
      url: "/api/v1/collections",
      payload: { name: "a/b?c" },
    });
    expect(badName.statusCode).toBe(400);

    const renamed = await t.app.inject({
      method: "PATCH",
      url: "/api/v1/collections/incident%202026-09-01",
      headers: { "x-shadow-actor": "arnav" },
      payload: { name: "refund-incident", description: null },
    });
    expect(json<Collection>(renamed)).toMatchObject({
      name: "refund-incident",
      description: null,
      traceCount: 1,
    });
    expect(await traceIds("collection=refund-incident")).toEqual([REFUND]);

    // Saved views can carry the collection filter.
    const view = await t.app.inject({
      method: "POST",
      url: "/api/v1/views",
      payload: { name: "incident failures", query: "status=failed&collection=refund-incident" },
    });
    expect(json<SavedView>(view).query).toBe("collection=refund-incident&status=failed");

    const deleted = await t.app.inject({
      method: "DELETE",
      url: "/api/v1/collections/refund-incident",
      headers: { "x-shadow-actor": "arnav" },
    });
    expect(deleted.statusCode).toBe(204);
    expect((await t.app.inject({ url: "/api/v1/collections/refund-incident" })).statusCode).toBe(
      404,
    );
    expect(await traceIds(`q=${REFUND}`)).toBeDefined();
    expect((await t.app.inject({ url: `/api/v1/traces/${REFUND}` })).statusCode).toBe(200);

    const log = json<{ items: AuditEntry[] }>(
      await t.app.inject({ url: "/api/v1/audit?actor=arnav" }),
    );
    expect(log.items.map((e) => e.action)).toEqual([
      "collection.deleted",
      "collection.updated",
      "collection.created",
    ]);
  });
});
