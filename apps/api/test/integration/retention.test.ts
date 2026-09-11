import { VirtualClock } from "@shadow/core";
import type { Trace, TraceSummary } from "@shadow/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRetention } from "../../src/retention.js";
import { createTestApp, json, type TestApp } from "../helpers.js";

const NOW = Date.parse("2026-09-11T12:00:00.000Z");
let t: TestApp;

async function createTrace(name: string, startedAt: string): Promise<string> {
  const created = await t.app.inject({
    method: "POST",
    url: "/api/v1/traces",
    payload: { project: "p", agent: "a", name, startedAt },
  });
  expect(created.statusCode).toBe(201);
  return json<Trace>(created).id;
}

async function listNames(): Promise<string[]> {
  const page = json<{ items: TraceSummary[] }>(
    await t.app.inject({ method: "GET", url: "/api/v1/traces?limit=200&order=asc" }),
  );
  return page.items.map((i) => i.name);
}

beforeAll(async () => {
  t = await createTestApp({ clock: new VirtualClock(NOW) });
});

afterAll(async () => {
  await t.close();
});

describe("retention", () => {
  it("is disabled without SHADOW_RETENTION_DAYS", async () => {
    await createTrace("ancient", "2020-01-01T00:00:00.000Z");
    const retention = createRetention({
      services: t.services,
      config: { SHADOW_RETENTION_DAYS: undefined, SHADOW_RETENTION_INTERVAL_MINUTES: 60 },
      logger: t.services.logger,
    });
    expect(retention.enabled).toBe(false);
    expect(await retention.runOnce()).toBeNull();
    retention.start();
    retention.stop();
    expect(await listNames()).toEqual(["ancient"]);
  });

  it("deletes traces older than the retention window, in batches", async () => {
    await createTrace("old-31d", "2026-08-11T11:59:59.000Z");
    await createTrace("edge-30d", "2026-08-12T12:00:00.000Z");
    await createTrace("fresh", "2026-09-10T00:00:00.000Z");
    const retention = createRetention({
      services: t.services,
      config: { SHADOW_RETENTION_DAYS: 30, SHADOW_RETENTION_INTERVAL_MINUTES: 60 },
      logger: t.services.logger,
    });
    expect(retention.enabled).toBe(true);
    const sweep = await retention.runOnce();
    expect(sweep).toEqual({ cutoff: "2026-08-12T12:00:00.000Z", deleted: 2, truncated: false });
    expect(await listNames()).toEqual(["edge-30d", "fresh"]);

    // A second sweep finds nothing new.
    expect((await retention.runOnce())?.deleted).toBe(0);
  });

  it("does not overlap concurrent sweeps", async () => {
    const retention = createRetention({
      services: t.services,
      config: { SHADOW_RETENTION_DAYS: 2, SHADOW_RETENTION_INTERVAL_MINUTES: 60 },
      logger: t.services.logger,
    });
    const [a, b] = await Promise.all([retention.runOnce(), retention.runOnce()]);
    expect(a).toBe(b);
    expect(await listNames()).toEqual(["fresh"]);
  });
});
