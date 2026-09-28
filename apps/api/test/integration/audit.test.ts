import type { AuditEntry, Branch, Fork, Trace } from "@shadow/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRetention } from "../../src/retention.js";
import { actorFrom } from "../../src/services/audit.js";
import {
  createTestApp,
  findEvent,
  ingestRefundScenario,
  json,
  type RefundScenario,
  type TestApp,
} from "../helpers.js";

let t: TestApp;
let scenario: RefundScenario;

async function auditFor(
  query: string,
): Promise<{ items: AuditEntry[]; nextCursor: string | null }> {
  const response = await t.app.inject({ url: `/api/v1/audit?${query}` });
  expect(response.statusCode).toBe(200);
  return json(response);
}

beforeAll(async () => {
  t = await createTestApp();
  scenario = await ingestRefundScenario(t, "trc_audit");
});

afterAll(async () => {
  await t.close();
});

describe("audit log", () => {
  it("records who forked, replayed, compared, renamed and deleted what", async () => {
    const alice = { "x-shadow-actor": "alice@example.com" };
    const patched = await t.app.inject({
      method: "PATCH",
      url: `/api/v1/traces/${scenario.traceId}`,
      headers: alice,
      payload: { tags: ["refund", "triaged"] },
    });
    expect(patched.statusCode).toBe(200);

    const forkEvent = findEvent(scenario.rootEvents, "tool.request", "refund_order");
    const forked = await t.app.inject({
      method: "POST",
      url: `/api/v1/traces/${scenario.traceId}/forks`,
      headers: { "x-shadow-actor": "bob" },
      payload: {
        forkEventId: forkEvent.id,
        name: "limit-100",
        overrides: [{ kind: "context", op: "set", key: "refundLimit", value: 100 }],
      },
    });
    const { branch, fork } = json<{ branch: Branch; fork: Fork }>(forked);
    await t.app.inject({
      method: "POST",
      url: `/api/v1/branches/${branch.id}/replay`,
      headers: { "x-shadow-actor": "bob" },
    });
    await t.app.inject({
      method: "POST",
      url: "/api/v1/comparisons",
      headers: { "x-shadow-actor": "bob" },
      payload: { baseBranchId: scenario.rootBranchId, targetBranchId: branch.id },
    });
    await t.app.inject({
      method: "PATCH",
      url: `/api/v1/branches/${branch.id}`,
      headers: alice,
      payload: { name: "limit-100-reviewed" },
    });
    const removed = await t.app.inject({
      method: "DELETE",
      url: `/api/v1/branches/${branch.id}`,
      headers: { "x-shadow-actor": "<script>alert(1)</script>" },
    });
    expect(removed.statusCode).toBe(200);

    const log = await auditFor(`traceId=${scenario.traceId}`);
    expect(log.items.map((e) => [e.action, e.actor])).toEqual([
      ["branch.deleted", "anonymous"],
      ["branch.updated", "alice@example.com"],
      ["comparison.created", "bob"],
      ["replay.run", "bob"],
      ["fork.created", "bob"],
      ["trace.updated", "alice@example.com"],
    ]);
    const [deleted, , , replay, created, updated] = log.items;
    expect(deleted).toMatchObject({
      targetType: "branch",
      targetId: branch.id,
      details: { name: "limit-100-reviewed", deleted: [branch.id] },
    });
    expect(replay?.details).toMatchObject({ mode: "deterministic", status: "completed" });
    expect(created?.details).toMatchObject({
      name: "limit-100",
      forkEventId: fork.forkEventId,
      overrides: [{ kind: "context", key: "refundLimit", value: 100 }],
    });
    expect(updated?.details).toEqual({ changes: { tags: ["refund", "triaged"] } });
    expect(updated?.requestId).toMatch(/^req_/);

    const bob = await auditFor("actor=bob&action=replay.run");
    expect(bob.items).toHaveLength(1);
  });

  it("keeps entries for deleted and pruned traces, and ignores dry runs", async () => {
    const created = await t.app.inject({
      method: "POST",
      url: "/api/v1/traces",
      payload: { project: "p", agent: "a", name: "doomed", startedAt: "2020-01-01T00:00:00.000Z" },
    });
    const doomed = json<Trace>(created).id;
    await t.app.inject({
      method: "DELETE",
      url: `/api/v1/traces/${doomed}`,
      headers: { "x-shadow-actor": "carol" },
    });
    const gone = await auditFor(`traceId=${doomed}`);
    expect(gone.items).toMatchObject([
      { action: "trace.deleted", actor: "carol", details: { name: "doomed", agent: "a" } },
    ]);

    await t.app.inject({
      method: "POST",
      url: "/api/v1/traces",
      payload: { project: "p", agent: "a", name: "old", startedAt: "2020-01-02T00:00:00.000Z" },
    });
    await t.app.inject({
      method: "POST",
      url: "/api/v1/traces/prune",
      payload: { before: "2021-01-01T00:00:00.000Z", dryRun: true },
    });
    expect((await auditFor("action=traces.pruned")).items).toHaveLength(0);
    await t.app.inject({
      method: "POST",
      url: "/api/v1/traces/prune",
      headers: { "x-shadow-actor": "carol" },
      payload: { before: "2021-01-01T00:00:00.000Z", dryRun: false },
    });
    const pruned = await auditFor("action=traces.pruned");
    expect(pruned.items).toMatchObject([
      { actor: "carol", details: { deleted: 1, before: "2021-01-01T00:00:00.000Z" } },
    ]);
  });

  it("logs retention sweeps as a system actor", async () => {
    await t.app.inject({
      method: "POST",
      url: "/api/v1/traces",
      payload: { project: "p", agent: "a", name: "ancient", startedAt: "2019-01-01T00:00:00.000Z" },
    });
    const retention = createRetention({
      services: t.services,
      config: {
        SHADOW_RETENTION_DAYS: 365,
        SHADOW_RETENTION_INTERVAL_MINUTES: 60,
        SHADOW_RETENTION_KEEP_TAG: "keep",
      },
      logger: t.services.logger,
    });
    await retention.runOnce();
    const sweeps = await auditFor("actor=system:retention");
    expect(sweeps.items).toHaveLength(1);
    expect(sweeps.items[0]).toMatchObject({
      action: "traces.pruned",
      details: { retentionDays: 365 },
    });
  });

  it("pages newest first without gaps or repeats", async () => {
    const all = await auditFor("limit=500");
    const seen: string[] = [];
    let cursor: string | null = "";
    while (cursor !== null) {
      const page = await auditFor(`limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      seen.push(...page.items.map((e) => e.id));
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(all.items.map((e) => e.id));
    expect(new Set(seen).size).toBe(seen.length);
    expect((await t.app.inject({ url: "/api/v1/audit?cursor=nope" })).statusCode).toBe(400);
  });
});

describe("actorFrom", () => {
  it("accepts plain names and rejects anything else", () => {
    expect(actorFrom("arnav")).toBe("arnav");
    expect(actorFrom(" ci-bot:deploy ")).toBe("ci-bot:deploy");
    expect(actorFrom(["first", "second"])).toBe("first");
    expect(actorFrom(undefined)).toBe("anonymous");
    expect(actorFrom("")).toBe("anonymous");
    expect(actorFrom("a\nb")).toBe("anonymous");
    expect(actorFrom("x".repeat(129))).toBe("anonymous");
  });
});
