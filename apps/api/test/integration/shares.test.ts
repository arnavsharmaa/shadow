import { VirtualClock } from "@shadow/core";
import type { AuditEntry, TraceExport, TraceShare } from "@shadow/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestApp,
  ingestRefundScenario,
  json,
  type RefundScenario,
  type TestApp,
} from "../helpers.js";

const TOKEN = "team-secret";
const auth = { authorization: `Bearer ${TOKEN}` };
const clock = new VirtualClock(Date.parse("2026-09-28T09:00:00.000Z"));
let t: TestApp;
let scenario: RefundScenario;

interface Created {
  share: TraceShare;
  token: string;
  path: string;
}

async function share(payload: Record<string, unknown> = {}): Promise<Created> {
  const response = await t.app.inject({
    method: "POST",
    url: `/api/v1/traces/${scenario.traceId}/shares`,
    headers: { ...auth, "x-shadow-actor": "arnav" },
    payload,
  });
  expect(response.statusCode).toBe(201);
  return json<Created>(response);
}

beforeAll(async () => {
  t = await createTestApp({ env: { SHADOW_API_TOKEN: TOKEN }, clock });
  scenario = await ingestRefundScenario(t, "trc_shared", { headers: auth });
});

afterAll(async () => {
  await t.close();
});

describe("read-only share links", () => {
  it("serves the trace bundle without the API token until revoked", async () => {
    const created = await share({ expiresInHours: 48, note: "for the vendor" });
    expect(created.token).toMatch(/^shs_[A-Za-z0-9_-]{43}$/);
    expect(created.path).toBe(`/api/v1/shared/${created.token}`);
    expect(created.share).toMatchObject({
      traceId: scenario.traceId,
      note: "for the vendor",
      expiresAt: "2026-09-30T09:00:00.000Z",
      revokedAt: null,
      accessCount: 0,
    });

    // Everything else still requires the bearer token.
    expect((await t.app.inject({ url: "/api/v1/traces" })).statusCode).toBe(401);
    const opened = await t.app.inject({ url: created.path });
    expect(opened.statusCode).toBe(200);
    expect(opened.headers["cache-control"]).toBe("private, no-store");
    const bundle = json<TraceExport>(opened);
    expect(bundle.format).toBe("shadow.trace");
    expect(bundle.trace.id).toBe(scenario.traceId);
    expect(bundle.events.length).toBe(scenario.rootEvents.length);

    const listed = json<{ items: TraceShare[] }>(
      await t.app.inject({ url: `/api/v1/traces/${scenario.traceId}/shares`, headers: auth }),
    );
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({ id: created.share.id, accessCount: 1 });
    expect(JSON.stringify(listed)).not.toContain(created.token);

    const revoked = await t.app.inject({
      method: "DELETE",
      url: `/api/v1/traces/${scenario.traceId}/shares/${created.share.id}`,
      headers: { ...auth, "x-shadow-actor": "arnav" },
    });
    expect(revoked.statusCode).toBe(200);
    expect(json<TraceShare>(revoked).revokedAt).not.toBeNull();
    expect((await t.app.inject({ url: created.path })).statusCode).toBe(404);
    const again = await t.app.inject({
      method: "DELETE",
      url: `/api/v1/traces/${scenario.traceId}/shares/${created.share.id}`,
      headers: auth,
    });
    expect(again.statusCode).toBe(404);

    const log = json<{ items: AuditEntry[] }>(
      await t.app.inject({ url: `/api/v1/audit?traceId=${scenario.traceId}`, headers: auth }),
    );
    expect(log.items.slice(0, 2).map((e) => [e.action, e.actor])).toEqual([
      ["share.revoked", "arnav"],
      ["share.created", "arnav"],
    ]);
  });

  it("expires links and answers the same 404 for unknown tokens", async () => {
    const created = await share({ expiresInHours: 1 });
    expect((await t.app.inject({ url: created.path })).statusCode).toBe(200);
    clock.advance(60 * 60 * 1000);
    const expired = await t.app.inject({ url: created.path });
    expect(expired.statusCode).toBe(404);
    const unknown = await t.app.inject({ url: `/api/v1/shared/shs_${"x".repeat(43)}` });
    const malformed = await t.app.inject({ url: "/api/v1/shared/not-a-token" });
    expect(unknown.statusCode).toBe(404);
    expect(malformed.statusCode).toBe(404);
    expect(json<{ error: { message: string } }>(unknown).error.message).toBe(
      json<{ error: { message: string } }>(expired).error.message,
    );
  });

  it("validates the lifetime and dies with the trace", async () => {
    const tooLong = await t.app.inject({
      method: "POST",
      url: `/api/v1/traces/${scenario.traceId}/shares`,
      headers: auth,
      payload: { expiresInHours: 24 * 31 },
    });
    expect(tooLong.statusCode).toBe(400);
    const defaults = await t.app.inject({
      method: "POST",
      url: `/api/v1/traces/${scenario.traceId}/shares`,
      headers: auth,
    });
    expect(defaults.statusCode).toBe(201);
    const created = json<Created>(defaults);
    expect(Date.parse(created.share.expiresAt) - Date.parse(created.share.createdAt)).toBe(
      7 * 24 * 60 * 60 * 1000,
    );
    await t.app.inject({
      method: "DELETE",
      url: `/api/v1/traces/${scenario.traceId}`,
      headers: auth,
    });
    expect((await t.app.inject({ url: created.path })).statusCode).toBe(404);
  });
});
