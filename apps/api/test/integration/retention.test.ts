import { VirtualClock } from "@shadow/core";
import type { Trace, TraceSummary } from "@shadow/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditLog } from "../../src/db/schema.js";
import { createRetention } from "../../src/retention.js";
import { createTestApp, json, type TestApp } from "../helpers.js";

const NOW = Date.parse("2026-09-11T12:00:00.000Z");
let t: TestApp;

async function createTrace(
  name: string,
  startedAt: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const created = await t.app.inject({
    method: "POST",
    url: "/api/v1/traces",
    payload: { project: "p", agent: "a", name, startedAt, ...extra },
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
      config: {
        SHADOW_RETENTION_DAYS: undefined,
        SHADOW_RETENTION_INTERVAL_MINUTES: 60,
        SHADOW_RETENTION_KEEP_TAG: "keep",
        SHADOW_AUDIT_RETENTION_DAYS: undefined,
      },
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
    await createTrace("old-kept", "2026-07-01T00:00:00.000Z", { tags: ["keep", "audit"] });
    await createTrace("edge-30d", "2026-08-12T12:00:00.000Z");
    await createTrace("fresh", "2026-09-10T00:00:00.000Z");
    const retention = createRetention({
      services: t.services,
      config: {
        SHADOW_RETENTION_DAYS: 30,
        SHADOW_RETENTION_INTERVAL_MINUTES: 60,
        SHADOW_RETENTION_KEEP_TAG: "keep",
        SHADOW_AUDIT_RETENTION_DAYS: undefined,
      },
      logger: t.services.logger,
    });
    expect(retention.enabled).toBe(true);
    const sweep = await retention.runOnce();
    expect(sweep).toEqual({
      cutoff: "2026-08-12T12:00:00.000Z",
      deleted: 2,
      truncated: false,
      auditDeleted: 0,
      projects: [],
    });
    // The kept trace survives although it is the oldest of all.
    expect(await listNames()).toEqual(["old-kept", "edge-30d", "fresh"]);

    const unguarded = createRetention({
      services: t.services,
      config: {
        SHADOW_RETENTION_DAYS: 30,
        SHADOW_RETENTION_INTERVAL_MINUTES: 60,
        SHADOW_RETENTION_KEEP_TAG: undefined,
        SHADOW_AUDIT_RETENTION_DAYS: undefined,
      },
      logger: t.services.logger,
    });
    expect((await unguarded.runOnce())?.deleted).toBe(1);
    expect(await listNames()).toEqual(["edge-30d", "fresh"]);

    // A second sweep finds nothing new.
    expect((await retention.runOnce())?.deleted).toBe(0);
  });

  it("leaves traces in a collection alone unless told otherwise", async () => {
    await createTrace("old-collected", "2026-07-02T00:00:00.000Z");
    await createTrace("old-loose", "2026-07-03T00:00:00.000Z");
    const collected = json<{ items: TraceSummary[] }>(
      await t.app.inject({ url: "/api/v1/traces?q=old-collected" }),
    ).items[0];
    const created = await t.app.inject({
      method: "POST",
      url: "/api/v1/collections",
      payload: { name: "retention-incident", traceIds: [collected?.id ?? ""] },
    });
    expect(created.statusCode, created.body).toBe(201);
    const config = {
      SHADOW_RETENTION_DAYS: 30,
      SHADOW_RETENTION_INTERVAL_MINUTES: 60,
      SHADOW_RETENTION_KEEP_TAG: "keep",
      SHADOW_AUDIT_RETENTION_DAYS: undefined,
    };
    const careful = createRetention({ services: t.services, config, logger: t.services.logger });
    expect((await careful.runOnce())?.deleted).toBe(1);
    expect(await listNames()).toEqual(["old-collected", "edge-30d", "fresh"]);
    const sweeping = createRetention({
      services: t.services,
      config: { ...config, SHADOW_RETENTION_KEEP_COLLECTED: false },
      logger: t.services.logger,
    });
    expect((await sweeping.runOnce())?.deleted).toBe(1);
    expect(await listNames()).toEqual(["edge-30d", "fresh"]);
    await t.app.inject({ method: "DELETE", url: "/api/v1/collections/retention-incident" });
  });

  it("applies per-project windows and leaves those projects out of the global pass", async () => {
    const make = (project: string, name: string, startedAt: string) =>
      t.app.inject({
        method: "POST",
        url: "/api/v1/traces",
        payload: { project, agent: "a", name, startedAt },
      });
    // NOW is 2026-09-11T12:00Z: ages below are relative to that.
    await make("ci", "ci-8d", "2026-09-03T12:00:00.000Z");
    await make("ci", "ci-2d", "2026-09-09T12:00:00.000Z");
    await make("support", "support-40d", "2026-08-02T12:00:00.000Z");
    await make("support", "support-20d", "2026-08-22T12:00:00.000Z");
    await make("other", "other-40d", "2026-08-02T12:00:00.000Z");
    await make("other", "other-20d", "2026-08-22T12:00:00.000Z");
    const mine = ["ci", "support", "other"];
    const names = async () => {
      const out: string[] = [];
      for (const project of ["other", "support", "ci"]) {
        const page = json<{ items: TraceSummary[] }>(
          await t.app.inject({ url: `/api/v1/traces?limit=200&order=asc&project=${project}` }),
        );
        out.push(...page.items.map((i) => i.name));
      }
      return out;
    };

    // Project windows alone: the global pass is off, so "other" is untouched.
    const projectOnly = createRetention({
      services: t.services,
      config: {
        SHADOW_RETENTION_DAYS: undefined,
        SHADOW_RETENTION_INTERVAL_MINUTES: 60,
        SHADOW_RETENTION_KEEP_TAG: "keep",
        SHADOW_AUDIT_RETENTION_DAYS: undefined,
        SHADOW_RETENTION_PROJECT_DAYS: { ci: 7, support: 30 },
      },
      logger: t.services.logger,
    });
    expect(projectOnly.enabled).toBe(true);
    const first = await projectOnly.runOnce();
    expect(first).toMatchObject({
      cutoff: null,
      deleted: 0,
      projects: [
        { project: "ci", days: 7, deleted: 1, truncated: false },
        { project: "support", days: 30, deleted: 1, truncated: false },
      ],
    });
    expect(await names()).toEqual(["other-40d", "other-20d", "support-20d", "ci-2d"]);

    // With a global window too, listed projects keep their own and the rest follow the global.
    const both = createRetention({
      services: t.services,
      config: {
        SHADOW_RETENTION_DAYS: 30,
        SHADOW_RETENTION_INTERVAL_MINUTES: 60,
        SHADOW_RETENTION_KEEP_TAG: "keep",
        SHADOW_AUDIT_RETENTION_DAYS: undefined,
        SHADOW_RETENTION_PROJECT_DAYS: { ci: 1 },
      },
      logger: t.services.logger,
    });
    const second = await both.runOnce();
    expect(second).toMatchObject({
      deleted: 1,
      projects: [{ project: "ci", days: 1, deleted: 1 }],
    });
    expect(await names()).toEqual(["other-20d", "support-20d"]);
    const log = await t.handle.db.select().from(auditLog);
    const projectEntries = log.filter(
      (e) => e.action === "traces.pruned" && (e.details as { project?: string }).project === "ci",
    );
    expect(projectEntries).toHaveLength(2);
    expect(projectEntries[0]?.details).toMatchObject({ retentionDays: 7, project: "ci" });
    // Leave the shared database as the later tests expect it.
    for (const project of mine) {
      const page = json<{ items: TraceSummary[] }>(
        await t.app.inject({ url: `/api/v1/traces?limit=200&project=${project}` }),
      );
      for (const item of page.items) {
        await t.app.inject({ method: "DELETE", url: `/api/v1/traces/${item.id}` });
      }
    }
  });

  it("does not overlap concurrent sweeps", async () => {
    const retention = createRetention({
      services: t.services,
      config: {
        SHADOW_RETENTION_DAYS: 2,
        SHADOW_RETENTION_INTERVAL_MINUTES: 60,
        SHADOW_RETENTION_KEEP_TAG: "keep",
        SHADOW_AUDIT_RETENTION_DAYS: undefined,
      },
      logger: t.services.logger,
    });
    const [a, b] = await Promise.all([retention.runOnce(), retention.runOnce()]);
    expect(a).toBe(b);
    expect(await listNames()).toEqual(["fresh"]);
  });
});

describe("audit retention", () => {
  it("prunes old audit entries on the sweep, with or without trace retention", async () => {
    // Two entries: one recorded "now", one back-dated beyond the window.
    await t.app.inject({
      method: "POST",
      url: "/api/v1/views",
      payload: { name: "audit-retention-view", query: "status=failed" },
    });
    const old = new Date(NOW - 400 * 86_400_000).toISOString();
    await t.handle.db.insert(auditLog).values({
      id: "aud_ancient",
      at: old,
      actor: "ghost",
      action: "trace.deleted",
      targetType: "trace",
      targetId: "trc_gone",
      traceId: null,
      details: {},
      requestId: null,
    });
    const auditOnly = createRetention({
      services: t.services,
      config: {
        SHADOW_RETENTION_DAYS: undefined,
        SHADOW_RETENTION_INTERVAL_MINUTES: 60,
        SHADOW_RETENTION_KEEP_TAG: "keep",
        SHADOW_AUDIT_RETENTION_DAYS: 365,
      },
      logger: t.services.logger,
    });
    expect(auditOnly.enabled).toBe(true);
    expect(await auditOnly.runOnce()).toEqual({
      cutoff: null,
      deleted: 0,
      truncated: false,
      auditDeleted: 1,
      projects: [],
    });
    const remaining = json<{ items: { id: string }[] }>(
      await t.app.inject({ url: "/api/v1/audit?limit=500" }),
    ).items.map((e) => e.id);
    expect(remaining).not.toContain("aud_ancient");
    expect(remaining.length).toBeGreaterThan(0);
    expect((await auditOnly.runOnce())?.auditDeleted).toBe(0);
  });
});
