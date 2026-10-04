import type { ApiKey, AuditEntry } from "@shadow/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scopeAllows } from "../../src/services/keys.js";
import { createTestApp, json, type ErrorEnvelope, type TestApp } from "../helpers.js";

const TOKEN = "admin-token";
const admin = { authorization: `Bearer ${TOKEN}` };
let t: TestApp;

async function createKey(name: string, scope: string): Promise<{ key: ApiKey; secret: string }> {
  const response = await t.app.inject({
    method: "POST",
    url: "/api/v1/keys",
    headers: { ...admin, "x-shadow-actor": "arnav" },
    payload: { name, scope },
  });
  expect(response.statusCode, response.body).toBe(201);
  return json(response);
}

const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });

beforeAll(async () => {
  t = await createTestApp({ env: { SHADOW_API_TOKEN: TOKEN } });
});

afterAll(async () => {
  await t.close();
});

describe("scopeAllows", () => {
  it("maps scopes to request shapes", () => {
    expect(scopeAllows("admin", "DELETE", "/api/v1/traces/trc_1")).toBe(true);
    expect(scopeAllows("read", "GET", "/api/v1/traces?limit=5")).toBe(true);
    expect(scopeAllows("read", "POST", "/api/v1/traces")).toBe(false);
    expect(scopeAllows("ingest", "POST", "/api/v1/traces")).toBe(true);
    expect(scopeAllows("ingest", "POST", "/api/v1/traces/trc_1/events")).toBe(true);
    expect(scopeAllows("ingest", "PATCH", "/api/v1/traces/trc_1")).toBe(true);
    expect(scopeAllows("ingest", "POST", "/api/v1/otlp/v1/traces")).toBe(true);
    expect(scopeAllows("ingest", "POST", "/api/v1/import/anthropic")).toBe(true);
    expect(scopeAllows("ingest", "GET", "/api/v1/traces")).toBe(false);
    expect(scopeAllows("ingest", "POST", "/api/v1/traces/trc_1/forks")).toBe(false);
    expect(scopeAllows("ingest", "DELETE", "/api/v1/traces/trc_1")).toBe(false);
    expect(scopeAllows("ingest", "POST", "/api/v1/keys")).toBe(false);
  });
});

describe("API keys", () => {
  it("issues scoped keys that work as bearer tokens", async () => {
    const ingest = await createKey("ci-ingest", "ingest");
    expect(ingest.secret).toMatch(/^shk_[A-Za-z0-9_-]{43}$/);
    expect(ingest.key).toMatchObject({
      name: "ci-ingest",
      scope: "ingest",
      prefix: ingest.secret.slice(0, 12),
      lastUsedAt: null,
      revokedAt: null,
    });
    const reader = await createKey("dashboard", "read");
    const root = await createKey("ops", "admin");

    // The ingest key records traces but cannot read or change anything else.
    const created = await t.app.inject({
      method: "POST",
      url: "/api/v1/traces",
      headers: bearer(ingest.secret),
      payload: { project: "p", agent: "a", name: "from ci" },
    });
    expect(created.statusCode).toBe(201);
    const { id } = json<{ id: string }>(created);
    const events = await t.app.inject({
      method: "POST",
      url: `/api/v1/traces/${id}/events`,
      headers: bearer(ingest.secret),
      payload: { events: [{ eventType: "trace.started", name: "trace.started" }] },
    });
    expect(events.statusCode).toBe(201);
    const tagged = await t.app.inject({
      method: "PATCH",
      url: `/api/v1/traces/${id}`,
      headers: { ...bearer(ingest.secret), "x-shadow-actor": "impostor" },
      payload: { tags: ["ci"] },
    });
    expect(tagged.statusCode).toBe(200);
    const denied = await t.app.inject({ url: "/api/v1/traces", headers: bearer(ingest.secret) });
    expect(denied.statusCode).toBe(403);
    expect(json<ErrorEnvelope>(denied).error.code).toBe("forbidden");
    expect(
      (
        await t.app.inject({
          method: "DELETE",
          url: `/api/v1/traces/${id}`,
          headers: bearer(ingest.secret),
        })
      ).statusCode,
    ).toBe(403);

    // The read key reads; the admin key does everything, including key management.
    expect(
      (await t.app.inject({ url: "/api/v1/traces", headers: bearer(reader.secret) })).statusCode,
    ).toBe(200);
    expect(
      (
        await t.app.inject({
          method: "POST",
          url: "/api/v1/traces",
          headers: bearer(reader.secret),
          payload: { project: "p", agent: "a", name: "nope" },
        })
      ).statusCode,
    ).toBe(403);
    const listed = await t.app.inject({ url: "/api/v1/keys", headers: bearer(root.secret) });
    expect(listed.statusCode).toBe(200);
    const items = json<{ items: ApiKey[] }>(listed).items;
    expect(items.map((k) => k.name)).toEqual(["ci-ingest", "dashboard", "ops"]);
    expect(JSON.stringify(items)).not.toContain(ingest.secret.slice(12));
    expect(items.find((k) => k.name === "ci-ingest")?.lastUsedAt).not.toBeNull();

    // Changes made with a key are attributed to the key, whatever the request claims.
    const log = json<{ items: AuditEntry[] }>(
      await t.app.inject({ url: `/api/v1/audit?traceId=${id}`, headers: admin }),
    );
    expect(log.items[0]).toMatchObject({ action: "trace.updated", actor: "key:ci-ingest" });
    const created_ = json<{ items: AuditEntry[] }>(
      await t.app.inject({ url: "/api/v1/audit?action=key.created", headers: admin }),
    );
    expect(created_.items.map((e) => [e.actor, e.details.name])).toEqual([
      ["arnav", "ops"],
      ["arnav", "dashboard"],
      ["arnav", "ci-ingest"],
    ]);
  });

  it("rejects unknown, malformed and revoked keys, and duplicate names", async () => {
    const unknown = await t.app.inject({
      url: "/api/v1/traces",
      headers: bearer(`shk_${"a".repeat(43)}`),
    });
    expect(unknown.statusCode).toBe(401);
    expect(
      (await t.app.inject({ url: "/api/v1/traces", headers: bearer("nonsense") })).statusCode,
    ).toBe(401);

    const temp = await createKey("temporary", "read");
    expect(
      (await t.app.inject({ url: "/api/v1/traces", headers: bearer(temp.secret) })).statusCode,
    ).toBe(200);
    const revoked = await t.app.inject({
      method: "DELETE",
      url: "/api/v1/keys/temporary",
      headers: admin,
    });
    expect(revoked.statusCode).toBe(200);
    expect(json<ApiKey>(revoked).revokedAt).not.toBeNull();
    expect(
      (await t.app.inject({ url: "/api/v1/traces", headers: bearer(temp.secret) })).statusCode,
    ).toBe(401);
    expect(
      (await t.app.inject({ method: "DELETE", url: "/api/v1/keys/temporary", headers: admin }))
        .statusCode,
    ).toBe(404);

    const duplicate = await t.app.inject({
      method: "POST",
      url: "/api/v1/keys",
      headers: admin,
      payload: { name: "ci-ingest" },
    });
    expect(duplicate.statusCode).toBe(409);
    const badScope = await t.app.inject({
      method: "POST",
      url: "/api/v1/keys",
      headers: admin,
      payload: { name: "x", scope: "root" },
    });
    expect(badScope.statusCode).toBe(400);
    // Nobody manages keys without the token or an admin key.
    expect(
      (await t.app.inject({ method: "POST", url: "/api/v1/keys", payload: { name: "y" } }))
        .statusCode,
    ).toBe(401);
  });
});
