import type { Trace, TraceSummary } from "@shadow/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, json, type ErrorEnvelope, type TestApp } from "../helpers.js";

let t: TestApp;
let traceId: string;

beforeAll(async () => {
  t = await createTestApp();
  const created = await t.app.inject({
    method: "POST",
    url: "/api/v1/traces",
    payload: {
      project: "support-agent",
      agent: "refund-agent",
      name: "original name",
      tags: ["refund", "email"],
      metadata: { ticketId: "TCK-1", region: "eu" },
    },
  });
  traceId = json<Trace>(created).id;
});

afterAll(async () => {
  await t.close();
});

describe("PATCH /traces/:traceId", () => {
  it("renames, adjusts tags and merges metadata", async () => {
    const response = await t.app.inject({
      method: "PATCH",
      url: `/api/v1/traces/${traceId}`,
      payload: {
        name: "renamed trace",
        addTags: ["triaged", "refund"],
        removeTags: ["email"],
        metadata: { region: null, owner: "jordan", priority: 2 },
      },
    });
    expect(response.statusCode).toBe(200);
    const trace = json<Trace>(response);
    expect(trace.name).toBe("renamed trace");
    expect(trace.tags).toEqual(["refund", "triaged"]);
    expect(trace.metadata).toEqual({ ticketId: "TCK-1", owner: "jordan", priority: 2 });
    expect(trace.updatedAt >= trace.createdAt).toBe(true);

    const fetched = json<{ trace: TraceSummary }>(
      await t.app.inject({ method: "GET", url: `/api/v1/traces/${traceId}` }),
    );
    expect(fetched.trace.name).toBe("renamed trace");
    expect(fetched.trace.tags).toEqual(["refund", "triaged"]);
  });

  it("replaces the whole tag list and makes new values searchable", async () => {
    const response = await t.app.inject({
      method: "PATCH",
      url: `/api/v1/traces/${traceId}`,
      payload: { tags: ["escalated"] },
    });
    expect(json<Trace>(response).tags).toEqual(["escalated"]);

    const byTag = json<{ items: TraceSummary[] }>(
      await t.app.inject({ method: "GET", url: "/api/v1/traces?tag=escalated" }),
    );
    expect(byTag.items.map((i) => i.id)).toEqual([traceId]);
    const byOldTag = json<{ items: TraceSummary[] }>(
      await t.app.inject({ method: "GET", url: "/api/v1/traces?tag=triaged" }),
    );
    expect(byOldTag.items).toHaveLength(0);
    const byName = json<{ items: TraceSummary[] }>(
      await t.app.inject({ method: "GET", url: "/api/v1/traces?q=renamed" }),
    );
    expect(byName.items.map((i) => i.id)).toEqual([traceId]);
    const byMeta = json<{ items: TraceSummary[] }>(
      await t.app.inject({ method: "GET", url: "/api/v1/traces?q=jordan" }),
    );
    expect(byMeta.items.map((i) => i.id)).toEqual([traceId]);
  });

  it("rejects empty bodies, invalid fields and unknown traces", async () => {
    const empty = await t.app.inject({
      method: "PATCH",
      url: `/api/v1/traces/${traceId}`,
      payload: {},
    });
    expect(empty.statusCode).toBe(400);
    expect(json<ErrorEnvelope>(empty).error.code).toBe("validation_error");

    const badName = await t.app.inject({
      method: "PATCH",
      url: `/api/v1/traces/${traceId}`,
      payload: { name: "" },
    });
    expect(badName.statusCode).toBe(400);

    const missing = await t.app.inject({
      method: "PATCH",
      url: "/api/v1/traces/trc_missing",
      payload: { name: "x" },
    });
    expect(missing.statusCode).toBe(404);
  });
});
