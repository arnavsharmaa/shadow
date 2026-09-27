import type { SavedView } from "@shadow/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, json, type ErrorEnvelope, type TestApp } from "../helpers.js";

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await t.close();
});

describe("shared saved views", () => {
  it("creates, lists, replaces and deletes views", async () => {
    expect(json<{ items: SavedView[] }>(await t.app.inject({ url: "/api/v1/views" }))).toEqual({
      items: [],
    });

    const created = await t.app.inject({
      method: "POST",
      url: "/api/v1/views",
      payload: {
        name: " costly failures ",
        query: "?sort=totalEstimatedCost&status=failed&cursor=abc&limit=10",
        description: "failed runs, most expensive first",
      },
    });
    expect(created.statusCode).toBe(201);
    const view = json<SavedView>(created);
    expect(view).toMatchObject({
      name: "costly failures",
      // paging is dropped and keys are sorted so equal filters compare equal
      query: "sort=totalEstimatedCost&status=failed",
      description: "failed runs, most expensive first",
    });
    expect(view.id).toMatch(/^view_/);

    await t.app.inject({
      method: "POST",
      url: "/api/v1/views",
      payload: { name: "agents: refund", query: "agent=refund-agent" },
    });
    const listed = json<{ items: SavedView[] }>(await t.app.inject({ url: "/api/v1/views" }));
    expect(listed.items.map((v) => v.name)).toEqual(["agents: refund", "costly failures"]);

    // Saving under an existing name replaces its filters and keeps its id.
    const replaced = await t.app.inject({
      method: "POST",
      url: "/api/v1/views",
      payload: { name: "costly failures", query: "status=failed&minCost=0.01" },
    });
    expect(replaced.statusCode).toBe(200);
    expect(json<SavedView>(replaced)).toMatchObject({
      id: view.id,
      query: "minCost=0.01&status=failed",
      description: null,
    });

    const byName = json<{ items: SavedView[] }>(
      await t.app.inject({ url: "/api/v1/views?name=costly%20failures" }),
    );
    expect(byName.items.map((v) => v.id)).toEqual([view.id]);
    const missing = await t.app.inject({ url: "/api/v1/views?name=nope" });
    expect(missing.statusCode).toBe(404);

    const deleted = await t.app.inject({ method: "DELETE", url: `/api/v1/views/${view.id}` });
    expect(deleted.statusCode).toBe(204);
    const again = await t.app.inject({ method: "DELETE", url: `/api/v1/views/${view.id}` });
    expect(again.statusCode).toBe(404);
    expect(
      json<{ items: SavedView[] }>(await t.app.inject({ url: "/api/v1/views" })).items.map(
        (v) => v.name,
      ),
    ).toEqual(["agents: refund"]);
  });

  it("rejects queries the trace list would not accept", async () => {
    for (const query of [
      "status=exploded",
      "sort=nonsense",
      "unknown=1",
      "minCost=-1",
      "status=failed&status=completed",
    ]) {
      const response = await t.app.inject({
        method: "POST",
        url: "/api/v1/views",
        payload: { name: "bad", query },
      });
      expect(response.statusCode, query).toBe(400);
      expect(json<ErrorEnvelope>(response).error.code).toBe("validation_error");
    }
    const blank = await t.app.inject({
      method: "POST",
      url: "/api/v1/views",
      payload: { name: "   ", query: "" },
    });
    expect(blank.statusCode).toBe(400);
  });

  it("stores an empty query as the unfiltered explorer", async () => {
    const response = await t.app.inject({
      method: "POST",
      url: "/api/v1/views",
      payload: { name: "everything", query: "" },
    });
    expect(response.statusCode).toBe(201);
    expect(json<SavedView>(response).query).toBe("");
  });
});
