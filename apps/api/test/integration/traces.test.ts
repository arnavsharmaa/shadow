import type { Agent, Branch, Project, Trace, TraceSummary } from "@shadow/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, json, type ErrorEnvelope, type TestApp } from "../helpers.js";

describe("trace CRUD", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  it("lists nothing on an empty database", async () => {
    const response = await t.app.inject({ method: "GET", url: "/api/v1/traces" });
    expect(response.statusCode).toBe(200);
    expect(json(response)).toEqual({ items: [], nextCursor: null, total: 0 });
  });

  it("creates a trace with its root branch and auto-created project/agent", async () => {
    const created = await t.app.inject({
      method: "POST",
      url: "/api/v1/traces",
      payload: {
        project: "Support Agent",
        agent: "Refund Agent",
        name: "first trace",
        tags: ["a"],
      },
    });
    expect(created.statusCode).toBe(201);
    const trace = json<Trace>(created);
    expect(trace.id).toMatch(/^trc_[a-f0-9]{32}$/);
    expect(trace.rootBranchId).toMatch(/^br_[a-f0-9]{32}$/);
    expect(trace.status).toBe("running");
    expect(trace.branchCount).toBe(1);
    expect(trace.tags).toEqual(["a"]);
    expect(trace.metrics.eventCount).toBe(0);
    expect(trace.schemaVersion).toBe("1.0");
    expect(trace.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const fetched = await t.app.inject({ method: "GET", url: `/api/v1/traces/${trace.id}` });
    expect(fetched.statusCode).toBe(200);
    const body = json<{ trace: TraceSummary; branches: Branch[] }>(fetched);
    expect(body.trace.id).toBe(trace.id);
    expect(body.trace.projectSlug).toBe("support-agent");
    expect(body.trace.projectName).toBe("Support Agent");
    expect(body.trace.agentSlug).toBe("refund-agent");
    expect(body.trace.agentName).toBe("Refund Agent");
    expect(body.branches).toHaveLength(1);
    expect(body.branches[0]).toMatchObject({
      id: trace.rootBranchId,
      traceId: trace.id,
      name: "main",
      depth: 0,
      status: "recording",
      parentBranchId: null,
      forkId: null,
    });

    const projects = json<{ items: Project[] }>(
      await t.app.inject({ method: "GET", url: "/api/v1/projects" }),
    );
    expect(projects.items.map((p) => p.slug)).toContain("support-agent");
    const project = projects.items.find((p) => p.slug === "support-agent");
    const agents = json<{ items: Agent[]; replayable: { slug: string }[] }>(
      await t.app.inject({ method: "GET", url: `/api/v1/agents?projectId=${project?.id ?? ""}` }),
    );
    expect(agents.items).toHaveLength(1);
    expect(agents.items[0]).toMatchObject({
      slug: "refund-agent",
      name: "Refund Agent",
      replayable: true,
    });
    expect(agents.replayable.map((d) => d.slug)).toEqual(
      expect.arrayContaining(["refund-agent", "inventory-agent"]),
    );
  });

  it("reuses the project and agent for later traces", async () => {
    const first = json<Trace>(
      await t.app.inject({
        method: "POST",
        url: "/api/v1/traces",
        payload: { project: "support-agent", agent: "refund-agent", name: "a" },
      }),
    );
    const second = json<Trace>(
      await t.app.inject({
        method: "POST",
        url: "/api/v1/traces",
        payload: { project: "support-agent", agent: "refund-agent", name: "b" },
      }),
    );
    expect(second.projectId).toBe(first.projectId);
    expect(second.agentId).toBe(first.agentId);
    expect(second.rootBranchId).not.toBe(first.rootBranchId);
  });

  it("honours an explicit id and rejects duplicates with 409", async () => {
    const payload = {
      id: "trc_explicit",
      project: "p",
      agent: "a",
      name: "explicit",
      startedAt: "2026-09-01T09:00:00.000Z",
    };
    const created = await t.app.inject({ method: "POST", url: "/api/v1/traces", payload });
    expect(created.statusCode).toBe(201);
    expect(json<Trace>(created)).toMatchObject({
      id: "trc_explicit",
      startedAt: "2026-09-01T09:00:00.000Z",
    });

    const duplicate = await t.app.inject({ method: "POST", url: "/api/v1/traces", payload });
    expect(duplicate.statusCode).toBe(409);
    const body = json<ErrorEnvelope>(duplicate);
    expect(body.error.code).toBe("conflict");
    expect(body.error.details).toEqual({ traceId: "trc_explicit" });
    expect(duplicate.headers["x-request-id"]).toBe(body.error.requestId);
  });

  it("rejects invalid bodies with validation_error", async () => {
    const missing = await t.app.inject({
      method: "POST",
      url: "/api/v1/traces",
      payload: { project: "p" },
    });
    expect(missing.statusCode).toBe(400);
    const body = json<ErrorEnvelope>(missing);
    expect(body.error.code).toBe("validation_error");
    const details = body.error.details as { path: string; message: string }[];
    expect(details.map((d) => d.path)).toEqual(expect.arrayContaining(["/agent", "/name"]));

    const badDate = await t.app.inject({
      method: "POST",
      url: "/api/v1/traces",
      payload: { project: "p", agent: "a", name: "n", startedAt: "yesterday" },
    });
    expect(badDate.statusCode).toBe(400);
    expect(json<ErrorEnvelope>(badDate).error.code).toBe("validation_error");

    const badId = await t.app.inject({
      method: "POST",
      url: "/api/v1/traces",
      payload: { id: "has spaces", project: "p", agent: "a", name: "n" },
    });
    expect(badId.statusCode).toBe(400);
  });

  it("rejects slugs without letters or digits", async () => {
    const response = await t.app.inject({
      method: "POST",
      url: "/api/v1/traces",
      payload: { project: "!!!", agent: "a", name: "n" },
    });
    expect(response.statusCode).toBe(400);
    expect(json<ErrorEnvelope>(response).error.code).toBe("bad_request");
  });

  it("rejects malformed ids in path parameters", async () => {
    for (const url of [
      "/api/v1/traces/bad%20id!",
      "/api/v1/branches/bad%20id!",
      "/api/v1/comparisons/no%2Fslash",
      "/api/v1/traces/trc_ok/events/bad%20id!",
    ]) {
      const response = await t.app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(400);
      const body = json<ErrorEnvelope>(response);
      expect(body.error.code).toBe("validation_error");
      expect(response.headers["x-request-id"]).toBe(body.error.requestId);
    }
  });

  it("returns 404 for unknown traces", async () => {
    const response = await t.app.inject({
      method: "GET",
      url: "/api/v1/traces/trc_does_not_exist",
    });
    expect(response.statusCode).toBe(404);
    const body = json<ErrorEnvelope>(response);
    expect(body.error.code).toBe("not_found");
    expect(body.error.details).toEqual({ resource: "trace", id: "trc_does_not_exist" });
    for (const suffix of ["/events", "/branches", "/forks", "/replays", "/export", "/tree"]) {
      const sub = await t.app.inject({
        method: "GET",
        url: `/api/v1/traces/trc_does_not_exist${suffix}`,
      });
      expect(sub.statusCode, suffix).toBe(404);
    }
  });

  it("deletes a trace", async () => {
    const trace = json<Trace>(
      await t.app.inject({
        method: "POST",
        url: "/api/v1/traces",
        payload: { project: "p", agent: "a", name: "to delete" },
      }),
    );
    const deleted = await t.app.inject({ method: "DELETE", url: `/api/v1/traces/${trace.id}` });
    expect(deleted.statusCode).toBe(204);
    expect(
      (await t.app.inject({ method: "GET", url: `/api/v1/traces/${trace.id}` })).statusCode,
    ).toBe(404);
    expect(
      (await t.app.inject({ method: "GET", url: `/api/v1/branches/${trace.rootBranchId}` }))
        .statusCode,
    ).toBe(404);
    expect(
      (await t.app.inject({ method: "DELETE", url: `/api/v1/traces/${trace.id}` })).statusCode,
    ).toBe(404);
  });
});

describe("projects", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  it("creates projects explicitly and rejects duplicates", async () => {
    const created = await t.app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { slug: "custom", name: "Custom", description: "desc", metadata: { team: "x" } },
    });
    expect(created.statusCode).toBe(201);
    expect(json<Project>(created)).toMatchObject({
      slug: "custom",
      name: "Custom",
      description: "desc",
      metadata: { team: "x" },
    });

    const duplicate = await t.app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { slug: "custom", name: "Again" },
    });
    expect(duplicate.statusCode).toBe(409);

    const invalid = await t.app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { slug: "Bad Slug", name: "x" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(json<ErrorEnvelope>(invalid).error.code).toBe("validation_error");

    const list = json<{ items: Project[] }>(
      await t.app.inject({ method: "GET", url: "/api/v1/projects" }),
    );
    expect(list.items.map((p) => p.slug)).toEqual(["custom"]);
  });

  it("lists agents across projects with replayable programs", async () => {
    await t.app.inject({
      method: "POST",
      url: "/api/v1/traces",
      payload: { project: "one", agent: "custom-agent", name: "n" },
    });
    await t.app.inject({
      method: "POST",
      url: "/api/v1/traces",
      payload: { project: "two", agent: "inventory-agent", name: "n" },
    });
    const agents = json<{ items: Agent[]; replayable: { slug: string; name: string }[] }>(
      await t.app.inject({ method: "GET", url: "/api/v1/agents" }),
    );
    const bySlug = new Map(agents.items.map((a) => [a.slug, a]));
    expect(bySlug.get("custom-agent")?.replayable).toBe(false);
    expect(bySlug.get("inventory-agent")?.replayable).toBe(true);
    expect(agents.replayable.map((d) => d.slug)).toContain("inventory-agent");
  });
});
