import type { Trace, TraceSummary } from "@shadow/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, json, type ErrorEnvelope, type TestApp } from "../helpers.js";

let t: TestApp;
const ids: Record<string, string> = {};

async function createTrace(key: string, startedAt: string, extra: Record<string, unknown> = {}) {
  const created = await t.app.inject({
    method: "POST",
    url: "/api/v1/traces",
    payload: { project: "support-agent", agent: "refund-agent", name: key, startedAt, ...extra },
  });
  expect(created.statusCode).toBe(201);
  ids[key] = json<Trace>(created).id;
}

async function listIds(): Promise<string[]> {
  const page = json<{ items: TraceSummary[] }>(
    await t.app.inject({ method: "GET", url: "/api/v1/traces?limit=200&order=asc" }),
  );
  return page.items.map((i) => i.id);
}

beforeAll(async () => {
  t = await createTestApp();
  await createTrace("jan", "2026-01-10T00:00:00.000Z", { tags: ["archived"] });
  await createTrace("feb", "2026-02-10T00:00:00.000Z");
  await createTrace("mar", "2026-03-10T00:00:00.000Z", { tags: ["archived"] });
  await createTrace("aug", "2026-08-10T00:00:00.000Z");
  await createTrace("other", "2026-01-15T00:00:00.000Z", { project: "billing", agent: "invoicer" });
});

afterAll(async () => {
  await t.close();
});

describe("POST /traces/prune", () => {
  it("reports matches without deleting in a dry run", async () => {
    const response = await t.app.inject({
      method: "POST",
      url: "/api/v1/traces/prune",
      payload: { before: "2026-04-01T00:00:00.000Z", dryRun: true },
    });
    expect(response.statusCode).toBe(200);
    expect(json(response)).toEqual({
      dryRun: true,
      matched: 4,
      traceIds: [ids.jan, ids.other, ids.feb, ids.mar],
      truncated: false,
    });
    expect(await listIds()).toHaveLength(5);
  });

  it("honours filters and the limit, oldest first", async () => {
    const tagged = await t.app.inject({
      method: "POST",
      url: "/api/v1/traces/prune",
      payload: { before: "2026-04-01T00:00:00.000Z", tag: "archived", limit: 1 },
    });
    expect(json(tagged)).toEqual({
      dryRun: false,
      matched: 1,
      traceIds: [ids.jan],
      truncated: true,
    });
    expect(await listIds()).not.toContain(ids.jan);

    const byProject = await t.app.inject({
      method: "POST",
      url: "/api/v1/traces/prune",
      payload: { before: "2026-04-01T00:00:00.000Z", project: "billing" },
    });
    expect(json<{ traceIds: string[] }>(byProject).traceIds).toEqual([ids.other]);

    const remaining = await t.app.inject({
      method: "POST",
      url: "/api/v1/traces/prune",
      payload: { before: "2026-04-01T00:00:00.000Z" },
    });
    expect(json(remaining)).toEqual({
      dryRun: false,
      matched: 2,
      traceIds: [ids.feb, ids.mar],
      truncated: false,
    });
    expect(await listIds()).toEqual([ids.aug]);
    const gone = await t.app.inject({ method: "GET", url: `/api/v1/traces/${ids.jan}` });
    expect(gone.statusCode).toBe(404);
  });

  it("is a no-op when nothing matches and validates the cutoff", async () => {
    const nothing = await t.app.inject({
      method: "POST",
      url: "/api/v1/traces/prune",
      payload: { before: "2026-01-01T00:00:00.000Z" },
    });
    expect(json(nothing)).toEqual({ dryRun: false, matched: 0, traceIds: [], truncated: false });

    const missing = await t.app.inject({
      method: "POST",
      url: "/api/v1/traces/prune",
      payload: {},
    });
    expect(missing.statusCode).toBe(400);
    expect(json<ErrorEnvelope>(missing).error.code).toBe("validation_error");
    const notDate = await t.app.inject({
      method: "POST",
      url: "/api/v1/traces/prune",
      payload: { before: "yesterday" },
    });
    expect(notDate.statusCode).toBe(400);
  });
});
