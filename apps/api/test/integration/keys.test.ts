import type { ApiKey, AuditEntry } from "@shadow/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scopeAllows } from "../../src/services/keys.js";
import { refundPayload } from "../fixtures/otlp.js";
import {
  createTestApp,
  forkReplayCompare,
  ingestRefundScenario,
  json,
  type ErrorEnvelope,
  type TestApp,
} from "../helpers.js";

const TOKEN = "admin-token";
const admin = { authorization: `Bearer ${TOKEN}` };
let t: TestApp;

async function createKey(
  name: string,
  scope: string,
  project?: string,
): Promise<{ key: ApiKey; secret: string }> {
  const response = await t.app.inject({
    method: "POST",
    url: "/api/v1/keys",
    headers: { ...admin, "x-shadow-actor": "arnav" },
    payload: { name, scope, ...(project ? { project } : {}) },
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

  it("keeps an ingest key pinned to a project inside that project", async () => {
    const pinned = await createKey("support-ingest", "ingest", "support");
    expect(pinned.key.project).toBe("support");
    const h = bearer(pinned.secret);

    const own = await t.app.inject({
      method: "POST",
      url: "/api/v1/traces",
      headers: h,
      payload: { project: "support", agent: "a", name: "ours" },
    });
    expect(own.statusCode).toBe(201);
    const { id } = json<{ id: string }>(own);
    const other = await t.app.inject({
      method: "POST",
      url: "/api/v1/traces",
      headers: h,
      payload: { project: "billing", agent: "a", name: "theirs" },
    });
    expect(other.statusCode).toBe(403);
    expect(json<ErrorEnvelope>(other).error.message).toContain("pinned to project 'support'");

    // Requests about an existing trace must concern the key's project.
    const foreign = await t.app.inject({
      method: "POST",
      url: "/api/v1/traces",
      headers: admin,
      payload: { project: "billing", agent: "a", name: "not ours" },
    });
    const foreignId = json<{ id: string }>(foreign).id;
    const ownEvents = await t.app.inject({
      method: "POST",
      url: `/api/v1/traces/${id}/events`,
      headers: h,
      payload: { events: [{ eventType: "trace.started", name: "trace.started" }] },
    });
    expect(ownEvents.statusCode).toBe(201);
    const foreignEvents = await t.app.inject({
      method: "POST",
      url: `/api/v1/traces/${foreignId}/events`,
      headers: h,
      payload: { events: [{ eventType: "trace.started", name: "trace.started" }] },
    });
    expect(foreignEvents.statusCode).toBe(403);
    expect(
      (
        await t.app.inject({
          method: "PATCH",
          url: `/api/v1/traces/${foreignId}`,
          headers: h,
          payload: { tags: ["x"] },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await t.app.inject({
          method: "POST",
          url: "/api/v1/traces/trc_does_not_exist/events",
          headers: h,
          payload: { events: [{ eventType: "trace.started", name: "trace.started" }] },
        })
      ).statusCode,
    ).toBe(404);

    // Importers default to the pinned project and refuse another one.
    const imported = await t.app.inject({
      method: "POST",
      url: "/api/v1/import/anthropic",
      headers: h,
      payload: { messages: [{ role: "user", content: "hi" }] },
    });
    expect(imported.statusCode).toBe(201);
    const importedId = json<{ traceId: string }>(imported).traceId;
    expect(
      json<{ trace: { projectSlug: string } }>(
        await t.app.inject({ url: `/api/v1/traces/${importedId}`, headers: admin }),
      ).trace.projectSlug,
    ).toBe("support");
    expect(
      (
        await t.app.inject({
          method: "POST",
          url: "/api/v1/import/anthropic",
          headers: h,
          payload: { project: "billing", messages: [{ role: "user", content: "hi" }] },
        })
      ).statusCode,
    ).toBe(403);
    // The OTLP fixture names project "support" in its resource, so it passes; a payload without
    // a namespace lands in the pinned project, and another namespace is refused.
    const otlp = await t.app.inject({
      method: "POST",
      url: "/api/v1/otlp/v1/traces",
      headers: h,
      payload: refundPayload(),
    });
    expect(otlp.statusCode, otlp.body).toBe(200);
    const twin = JSON.parse(
      JSON.stringify(refundPayload())
        .replace(/4bf92f3577b34da6a3ce929d0e0e4736/g, "00000000000000000000000000000009")
        .replace('"support"', '"billing"'),
    ) as ReturnType<typeof refundPayload>;
    const refused = await t.app.inject({
      method: "POST",
      url: "/api/v1/otlp/v1/traces",
      headers: h,
      payload: twin,
    });
    expect(refused.statusCode).toBe(403);
    expect(
      (
        await t.app.inject({
          url: "/api/v1/traces/trc_otel_00000000000000000000000000000009",
          headers: admin,
        })
      ).statusCode,
    ).toBe(404);

    // The pin shows in the listing.
    const listed = json<{ items: ApiKey[] }>(
      await t.app.inject({ url: "/api/v1/keys", headers: admin }),
    );
    expect(listed.items.find((k) => k.name === "support-ingest")?.project).toBe("support");
    expect(listed.items.find((k) => k.name === "ci-ingest")?.project).toBeNull();
  });

  it("keeps a read key pinned to a project inside that project", async () => {
    const scenario = await ingestRefundScenario(t, "trc_test_read_pin", {
      seed: "read-pin",
      headers: admin,
    });
    const forked = await forkReplayCompare(t, scenario, { headers: admin });
    const foreign = json<{ id: string; rootBranchId: string }>(
      await t.app.inject({
        method: "POST",
        url: "/api/v1/traces",
        headers: admin,
        payload: { project: "billing", agent: "a", name: "theirs", tags: ["billing-only"] },
      }),
    );
    const reader = await createKey("support-reader", "read", "support-agent");
    expect(reader.key).toMatchObject({ scope: "read", project: "support-agent" });
    const h = bearer(reader.secret);
    const get = (url: string) => t.app.inject({ url, headers: h });
    const status = async (url: string) => (await get(url)).statusCode;

    // Listings and statistics take the pin as their project filter and refuse another one.
    const list = json<{ items: { projectSlug: string }[] }>(await get("/api/v1/traces"));
    expect(list.items.length).toBeGreaterThan(0);
    expect(list.items.every((i) => i.projectSlug === "support-agent")).toBe(true);
    expect(
      json<{ items: unknown[] }>(await get("/api/v1/traces?project=support-agent")).items,
    ).toEqual(list.items);
    const otherProject = await get("/api/v1/traces?project=billing");
    expect(otherProject.statusCode).toBe(403);
    expect(json<ErrorEnvelope>(otherProject).error.message).toContain("cannot read 'billing'");
    const facets = json<{
      projects: { slug: string }[];
      agents: { projectSlug: string }[];
      tags: string[];
      tools: string[];
    }>(await get("/api/v1/traces/facets"));
    expect(facets.projects.map((p) => p.slug)).toEqual(["support-agent"]);
    expect(facets.agents.every((a) => a.projectSlug === "support-agent")).toBe(true);
    expect(facets.tags).toContain("refund");
    expect(facets.tags).not.toContain("billing-only");
    expect(facets.tools).toContain("refund_order");
    const all = json<{ tags: string[] }>(
      await t.app.inject({ url: "/api/v1/traces/facets", headers: admin }),
    );
    expect(all.tags).toContain("billing-only");
    const projects = json<{ items: { id: string; slug: string }[] }>(await get("/api/v1/projects"));
    expect(projects.items.map((p) => p.slug)).toEqual(["support-agent"]);
    const agentList = json<{ items: { projectId: string }[] }>(await get("/api/v1/agents"));
    expect(agentList.items.length).toBeGreaterThan(0);
    expect(agentList.items.every((a) => a.projectId === projects.items[0]?.id)).toBe(true);
    const stats = json<{ items: { projectSlug: string }[] }>(await get("/api/v1/stats/agents"));
    expect(stats.items.length).toBeGreaterThan(0);
    expect(stats.items.every((a) => a.projectSlug === "support-agent")).toBe(true);
    expect(await status("/api/v1/stats/overview?days=90")).toBe(200);
    expect(await status("/api/v1/stats/overview?project=billing")).toBe(403);

    // Traces, branches and comparisons must belong to the project; unknown ids stay 404.
    expect(await status(`/api/v1/traces/${scenario.traceId}`)).toBe(200);
    expect(await status(`/api/v1/traces/${foreign.id}`)).toBe(403);
    expect(await status(`/api/v1/branches/${forked.branch.id}/events`)).toBe(200);
    expect(await status(`/api/v1/branches/${foreign.rootBranchId}`)).toBe(403);
    expect(await status("/api/v1/branches/br_does_not_exist")).toBe(404);
    expect(await status(`/api/v1/comparisons/${forked.comparison.id}`)).toBe(200);
    expect(await status("/api/v1/comparisons/cmp_does_not_exist")).toBe(404);
    expect(await status(`/api/v1/comparisons?traceId=${scenario.traceId}`)).toBe(200);
    expect(await status(`/api/v1/comparisons?traceId=${foreign.id}`)).toBe(403);
    const unscoped = await get("/api/v1/comparisons");
    expect(unscoped.statusCode).toBe(403);
    expect(json<ErrorEnvelope>(unscoped).error.message).toContain("traceId");

    // What is not scoped to a project is refused; the price table is harmless.
    const auditLog = await get("/api/v1/audit");
    expect(auditLog.statusCode).toBe(403);
    expect(json<ErrorEnvelope>(auditLog).error.message).toContain("not scoped to a project");
    expect(await status("/api/v1/keys")).toBe(403);
    expect(await status("/api/v1/alerts/rules")).toBe(403);
    expect(await status("/api/v1/pricing")).toBe(200);

    // Admin keys cannot be pinned.
    const bad = await t.app.inject({
      method: "POST",
      url: "/api/v1/keys",
      headers: admin,
      payload: { name: "pinned-admin", scope: "admin", project: "support-agent" },
    });
    expect(bad.statusCode).toBe(400);
    expect(json<ErrorEnvelope>(bad).error.message).toContain("admin keys cannot be pinned");
  });
});
