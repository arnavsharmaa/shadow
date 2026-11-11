import type { AuditEntry, TraceSummary } from "@shadow/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, json, type TestApp } from "../helpers.js";

let t: TestApp;

interface Tagged {
  matched: number;
  updated: string[];
  missing: string[];
}

async function list(query: string): Promise<TraceSummary[]> {
  return json<{ items: TraceSummary[] }>(await t.app.inject({ url: `/api/v1/traces?${query}` }))
    .items;
}

async function tag(payload: Record<string, unknown>) {
  return t.app.inject({
    method: "POST",
    url: "/api/v1/traces/tags",
    headers: { "x-shadow-actor": "arnav" },
    payload,
  });
}

beforeAll(async () => {
  t = await createTestApp();
  await t.seed();
});

afterAll(async () => {
  await t.close();
});

describe("bulk tagging", () => {
  it("tags every trace a selection matches and edits named traces", async () => {
    const failed = await list("agent=refund-agent&status=failed&limit=200");
    expect(failed.length).toBeGreaterThan(0);
    const all = await tag({
      query: { agent: "refund-agent", status: "failed" },
      add: ["triage", "triage"],
    });
    expect(all.statusCode).toBe(200);
    const first = json<Tagged>(all);
    expect(first.matched).toBe(failed.length);
    expect([...first.updated].sort()).toEqual(failed.map((f) => f.id).sort());
    expect(first.missing).toEqual([]);
    // The tag is on exactly those traces, once each, and the list filter finds them.
    const tagged = await list("tag=triage&limit=200");
    expect(tagged.map((x) => x.id).sort()).toEqual(failed.map((f) => f.id).sort());
    for (const trace of tagged) {
      expect(trace.tags.filter((x) => x === "triage")).toHaveLength(1);
    }

    // Named traces: one tag comes off, another goes on; unknown ids are reported, not fatal.
    const one = failed[0]?.id ?? "";
    const named = await tag({
      traceIds: [one, one, "trc_missing"],
      remove: ["triage"],
      add: ["reviewed"],
    });
    expect(json<Tagged>(named)).toEqual({ matched: 0, updated: [one], missing: ["trc_missing"] });
    const after = (await list("tag=reviewed&limit=200")).find((x) => x.id === one);
    expect(after?.tags).toContain("reviewed");
    expect(after?.tags).not.toContain("triage");
    expect(await list("tag=triage&limit=200")).toHaveLength(failed.length - 1);

    // Both calls are in the audit log with who made them.
    const audit = json<{ items: AuditEntry[] }>(
      await t.app.inject({ url: "/api/v1/audit?action=traces.tagged" }),
    ).items;
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({
      actor: "arnav",
      targetId: one,
      details: { add: ["reviewed"], remove: ["triage"], updated: 1 },
    });
    expect(audit[1]).toMatchObject({
      targetId: failed.length === 1 ? failed[0]?.id : "*",
      details: { add: ["triage", "triage"], updated: failed.length, matched: failed.length },
    });
  });

  it("needs traces and a change, and tolerates a selection that matches nothing", async () => {
    expect((await tag({ add: ["x"] })).statusCode).toBe(400);
    expect((await tag({ traceIds: ["trc_demo_refund_violation"] })).statusCode).toBe(400);
    const none = await tag({ query: { agent: "no-such-agent" }, add: ["x"] });
    expect(json<Tagged>(none)).toEqual({ matched: 0, updated: [], missing: [] });
    const audit = json<{ items: AuditEntry[] }>(
      await t.app.inject({ url: "/api/v1/audit?action=traces.tagged" }),
    ).items;
    // Nothing changed, so nothing was audited beyond the first test's two entries.
    expect(audit).toHaveLength(2);
  });
});
