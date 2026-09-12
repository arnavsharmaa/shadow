import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseCutoff } from "../src/format.js";
import { CLI_VERSION, run } from "../src/index.js";

interface Captured {
  out: string[];
  err: string[];
  calls: { method: string; url: string; body?: unknown; headers?: Record<string, string> }[];
}

function fakeApi(routes: Record<string, (body: unknown) => { status?: number; body: unknown }>): {
  fetch: typeof fetch;
  captured: Captured;
} {
  const captured: Captured = { out: [], err: [], calls: [] };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    captured.calls.push({
      method,
      url,
      body,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const parsed = new URL(url);
    const key = `${method} ${parsed.pathname}`;
    const handler = routes[key];
    if (!handler)
      return new Response(
        JSON.stringify({ error: { code: "not_found", message: `no route ${key}` } }),
        { status: 404 },
      );
    const result = handler(body);
    if (result.status === 204) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(result.body), {
      status: result.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, captured };
}

const trace = {
  id: "trc_1",
  projectId: "prj_1",
  agentId: "agt_1",
  rootBranchId: "br_main",
  name: "refund-request",
  status: "failed",
  schemaVersion: "1.0",
  startedAt: "2026-09-01T09:12:04.000Z",
  completedAt: null,
  durationMs: 4710,
  outcome: { kind: "policy_violation", label: "Policy violation" },
  tags: ["refund"],
  metadata: {},
  metrics: {
    eventCount: 52,
    modelCalls: 4,
    toolCalls: 6,
    toolErrors: 0,
    policyEvaluations: 2,
    inputTokens: 447,
    outputTokens: 176,
    totalTokens: 623,
    estimatedModelCost: 0.0028,
    estimatedToolCost: 0.002,
    totalEstimatedCost: 0.0048,
    durationMs: 4710,
    currency: "USD",
  },
  branchCount: 2,
  createdAt: "2026-09-02T12:00:00.000Z",
  updatedAt: "2026-09-02T12:00:00.000Z",
  projectSlug: "support-agent",
  projectName: "Support Agent",
  agentSlug: "refund-agent",
  agentName: "Refund Agent",
};

const branch = {
  id: "br_main",
  traceId: "trc_1",
  name: "main",
  parentBranchId: null,
  forkId: null,
  forkEventId: null,
  forkSequence: null,
  depth: 0,
  status: "failed",
  outcome: trace.outcome,
  metrics: trace.metrics,
  createdAt: trace.createdAt,
  updatedAt: trace.updatedAt,
  metadata: {},
};

function ev(
  sequence: number,
  eventType: string,
  name: string,
  extra: Record<string, unknown> = {},
) {
  return {
    id: `evt_${sequence}`,
    schemaVersion: "1.0",
    traceId: "trc_1",
    branchId: "br_main",
    parentEventId: null,
    spanId: null,
    parentSpanId: null,
    sequence,
    timestamp: "2026-09-01T09:12:04.000Z",
    durationMs: null,
    eventType,
    source: "seed",
    severity: "info",
    name,
    metadata: {},
    tags: [],
    tokenUsage: null,
    estimatedCost: null,
    stateVersion: null,
    correlationId: null,
    ...extra,
  };
}

function runWith(api: ReturnType<typeof fakeApi>, argv: string[]) {
  return run(argv, {
    fetch: api.fetch,
    stdout: (t) => api.captured.out.push(t),
    stderr: (t) => api.captured.err.push(t),
    env: { SHADOW_ENDPOINT: "http://shadow.test" },
  });
}

describe("shadow cli", () => {
  it("prints version and help with exit code 0", async () => {
    const api = fakeApi({});
    expect(await runWith(api, ["--version"])).toBe(0);
    expect(api.captured.out.join("\n")).toContain(CLI_VERSION);
    const help = fakeApi({});
    expect(await runWith(help, ["--help"])).toBe(0);
    const text = help.captured.out.join("\n");
    expect(text).toContain("traces");
    expect(text).toContain("replay");
    expect(text).toContain("compare");
  });

  it("sends a bearer token when configured and explains 401s", async () => {
    const api = fakeApi({
      "GET /api/v1/traces": () => ({ body: { items: [], nextCursor: null, total: 0 } }),
    });
    expect(await runWith(api, ["traces", "list", "--token", "s3cret"])).toBe(0);
    expect(api.captured.calls[0]?.headers?.authorization).toBe("Bearer s3cret");
    const denied = fakeApi({
      "GET /api/v1/traces": () => ({
        status: 401,
        body: { error: { code: "unauthorized", message: "nope" } },
      }),
    });
    expect(await runWith(denied, ["traces", "list"])).toBe(1);
    expect(denied.captured.err.join("\n")).toContain("--token");
  });

  it("reports API status with counts", async () => {
    const api = fakeApi({
      "GET /health": () => ({
        body: {
          status: "ok",
          version: "0.1.0",
          uptimeSeconds: 125,
          database: { kind: "pglite", location: "pglite:/tmp/data", healthy: true },
        },
      }),
      "GET /api/v1/traces": () => ({ body: { items: [trace], nextCursor: null, total: 7 } }),
      "GET /api/v1/traces/facets": () => ({
        body: {
          projects: [{ slug: "a" }, { slug: "b" }],
          agents: [{ slug: "x" }],
          tags: [],
          tools: ["t1", "t2", "t3"],
        },
      }),
    });
    expect(await runWith(api, ["status"])).toBe(0);
    const text = api.captured.out.join("\n");
    expect(text).toContain("0.1.0");
    expect(text).toContain("pglite");
    expect(text).toContain("7 across 2 project(s) and 1 agent(s); 3 distinct tool(s)");
    const json = fakeApi({
      "GET /health": () => ({
        body: {
          status: "degraded",
          version: "0.1.0",
          uptimeSeconds: 1,
          database: { kind: "postgres", location: "postgres://db:5432/shadow", healthy: false },
        },
      }),
      "GET /api/v1/traces": () => ({ body: { items: [], nextCursor: null, total: 0 } }),
      "GET /api/v1/traces/facets": () => ({
        body: { projects: [], agents: [], tags: [], tools: [] },
      }),
    });
    expect(await runWith(json, ["status", "--json"])).toBe(1);
    expect(JSON.parse(json.captured.out.join("\n")).database.healthy).toBe(false);
  });

  it("returns a usage exit code for unknown commands", async () => {
    const api = fakeApi({});
    expect(await runWith(api, ["frobnicate"])).toBe(2);
    expect(api.captured.err.join("\n")).toContain("unknown command");
  });

  it("lists traces as a table and as JSON with filters forwarded", async () => {
    const api = fakeApi({
      "GET /api/v1/traces": () => ({ body: { items: [trace], nextCursor: null, total: 1 } }),
    });
    expect(
      await runWith(api, [
        "traces",
        "list",
        "--project",
        "support-agent",
        "--status",
        "failed",
        "--limit",
        "5",
      ]),
    ).toBe(0);
    const text = api.captured.out.join("\n");
    expect(text).toContain("trc_1");
    expect(text).toContain("refund-agent");
    expect(text).toContain("1 of 1 traces");
    const url = new URL(api.captured.calls[0]?.url ?? "");
    expect(url.searchParams.get("project")).toBe("support-agent");
    expect(url.searchParams.get("status")).toBe("failed");
    expect(url.searchParams.get("limit")).toBe("5");

    const json = fakeApi({
      "GET /api/v1/traces": () => ({ body: { items: [trace], nextCursor: null, total: 1 } }),
    });
    expect(await runWith(json, ["traces", "list", "--json"])).toBe(0);
    expect(JSON.parse(json.captured.out.join("\n")).items[0].id).toBe("trc_1");
  });

  it("inspects a trace with an indented event tree", async () => {
    const api = fakeApi({
      "GET /api/v1/traces/trc_1": () => ({ body: { trace, branches: [branch] } }),
      "GET /api/v1/traces/trc_1/events": () => ({
        body: {
          items: [
            ev(0, "trace.started", "refund-request"),
            ev(1, "tool.request", "read_customer", { spanId: "spn_1" }),
            ev(2, "tool.response", "read_customer", {
              spanId: "spn_1",
              parentEventId: "evt_1",
              durationMs: 120,
            }),
          ],
          nextCursor: null,
        },
      }),
    });
    expect(await runWith(api, ["traces", "inspect", "trc_1"])).toBe(0);
    const text = api.captured.out.join("\n");
    expect(text).toContain("refund-request");
    expect(text).toContain("Policy violation");
    expect(text).toMatch(/1 {2}tool\.request/);
    expect(text).toMatch(/2 {4}tool\.response/);
    expect(text).toContain("120ms");
  });

  it("forwards inspect filters and prints matches flat", async () => {
    const api = fakeApi({
      "GET /api/v1/traces/trc_1": () => ({ body: { trace, branches: [branch] } }),
      "GET /api/v1/traces/trc_1/events": () => ({
        body: {
          items: [ev(3, "tool.request", "refund_order"), ev(4, "tool.response", "refund_order")],
          nextCursor: null,
        },
      }),
    });
    expect(
      await runWith(api, ["traces", "inspect", "trc_1", "--grep", "refund", "--severity", "info"]),
    ).toBe(0);
    const params = new URL(api.captured.calls[1]?.url ?? "").searchParams;
    expect(params.get("q")).toBe("refund");
    expect(params.get("severity")).toBe("info");
    expect(params.get("eventType")).toBeNull();
    const text = api.captured.out.join("\n");
    expect(text).toContain("2 matching");
    expect(text).toMatch(/^ {3}4 {2}tool\.response/m);
  });

  it("maps 404 responses to exit code 4 and connection failures to 3", async () => {
    const api = fakeApi({});
    expect(await runWith(api, ["traces", "inspect", "trc_missing"])).toBe(4);
    expect(api.captured.err.join("\n")).toContain("no route");
    const down = {
      fetch: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
      captured: { out: [], err: [], calls: [] } as Captured,
    };
    expect(await runWith(down, ["traces", "list"])).toBe(3);
    expect(down.captured.err.join("\n")).toContain("could not reach the Shadow API");
  });

  it("exports to a file and imports it back", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "shadow-cli-"));
    const file = path.join(dir, "trace.json");
    const bundle = {
      format: "shadow.trace",
      trace,
      branches: [branch],
      events: [ev(0, "trace.started", "x")],
      forks: [],
      replays: [],
      comparisons: [],
    };
    const api = fakeApi({
      "GET /api/v1/traces/trc_1/export": () => ({ body: bundle }),
      "POST /api/v1/traces/import": (body) => ({
        status: 201,
        body: {
          id: (body as { idStrategy: string }).idStrategy === "regenerate" ? "trc_copy" : "trc_1",
          branchCount: 1,
        },
      }),
    });
    expect(await runWith(api, ["traces", "export", "trc_1", "--out", file])).toBe(0);
    expect(JSON.parse(await readFile(file, "utf8")).format).toBe("shadow.trace");
    expect(await runWith(api, ["traces", "import", file, "--regenerate-ids"])).toBe(0);
    expect(api.captured.out.at(-1)).toContain("imported trace trc_copy");
    expect((api.captured.calls.at(-1)?.body as { idStrategy: string }).idStrategy).toBe(
      "regenerate",
    );
    await writeFile(file, "not json");
    expect(await runWith(api, ["traces", "import", file])).toBe(2);
  });

  it("updates trace names, tags and metadata", async () => {
    const api = fakeApi({
      "PATCH /api/v1/traces/trc_1": (body) => {
        const b = body as { name?: string; addTags?: string[]; removeTags?: string[] };
        return {
          body: {
            ...trace,
            name: b.name ?? trace.name,
            tags: [...trace.tags.filter((t) => !b.removeTags?.includes(t)), ...(b.addTags ?? [])],
            metadata: { owner: "jordan", priority: 2 },
          },
        };
      },
    });
    expect(
      await runWith(api, [
        "traces",
        "update",
        "trc_1",
        "--name",
        "renamed",
        "--tag",
        "triaged",
        "--untag",
        "refund",
        "--meta",
        "owner=jordan",
        "priority=2",
        "--unset-meta",
        "region",
      ]),
    ).toBe(0);
    const call = api.captured.calls[0];
    expect(call?.method).toBe("PATCH");
    expect(call?.body).toEqual({
      name: "renamed",
      addTags: ["triaged"],
      removeTags: ["refund"],
      metadata: { owner: "jordan", priority: 2, region: null },
    });
    const text = api.captured.out.join("\n");
    expect(text).toContain("updated trc_1");
    expect(text).toContain("name      renamed");
    expect(text).toContain("tags      triaged");
    expect(text).toContain("metadata  owner, priority");

    const replace = fakeApi({
      "PATCH /api/v1/traces/trc_1": () => ({ body: { ...trace, tags: ["a", "b"] } }),
    });
    expect(
      await runWith(replace, ["traces", "update", "trc_1", "--tags", "a", "b", "--json"]),
    ).toBe(0);
    expect(replace.captured.calls[0]?.body).toEqual({ tags: ["a", "b"] });
    expect(JSON.parse(replace.captured.out.join("\n")).tags).toEqual(["a", "b"]);

    const nothing = fakeApi({});
    expect(await runWith(nothing, ["traces", "update", "trc_1"])).toBe(2);
    expect(nothing.captured.err.join("\n")).toContain("nothing to update");
    expect(nothing.captured.calls).toHaveLength(0);
  });

  it("shows a single event with its payloads and state change", async () => {
    const event = ev(7, "tool.response", "refund_order", {
      durationMs: 812,
      input: { orderId: "ord_5001", amount: 480 },
      output: { status: "refunded" },
      parentEventId: "evt_6",
      tags: ["money"],
      estimatedCost: { amount: 0.002, currency: "USD" },
    });
    const api = fakeApi({
      "GET /api/v1/traces/trc_1/events/evt_7": () => ({ body: event }),
      "GET /api/v1/traces/trc_1/events/evt_7/state": () => ({
        body: {
          event: { id: "evt_7", sequence: 7 },
          branchId: "br_main",
          before: {},
          after: {},
          stateDiff: [
            { path: "/refund/status", op: "added", before: undefined, after: "refunded" },
          ],
          contextDiff: [],
        },
      }),
    });
    expect(await runWith(api, ["events", "show", "trc_1", "evt_7", "--branch", "br_main"])).toBe(0);
    expect(new URL(api.captured.calls[1]?.url ?? "").searchParams.get("branchId")).toBe("br_main");
    const text = api.captured.out.join("\n");
    expect(text).toContain("tool.response  refund_order");
    expect(text).toContain("sequence 7");
    expect(text).toContain("duration 812ms");
    expect(text).toContain("parent    evt_6");
    expect(text).toContain("est. cost $0.0020");
    expect(text).toContain('"orderId": "ord_5001"');
    expect(text).toContain('added    /refund/status  undefined -> "refunded"');
    expect(text).toContain("context diff (branch br_main)\n  no change");

    const asJson = fakeApi({
      "GET /api/v1/traces/trc_1/events/evt_7": () => ({ body: event }),
      "GET /api/v1/traces/trc_1/events/evt_7/state": () => ({
        body: { branchId: "br_main", stateDiff: [], contextDiff: [] },
      }),
    });
    expect(await runWith(asJson, ["events", "show", "trc_1", "evt_7", "--json"])).toBe(0);
    expect(JSON.parse(asJson.captured.out.join("\n")).event.id).toBe("evt_7");

    const missing = fakeApi({});
    expect(await runWith(missing, ["events", "show", "trc_1", "evt_404"])).toBe(4);
  });

  it("lists artifacts and downloads their content", async () => {
    const email = {
      id: "art_1",
      traceId: "trc_1",
      branchId: "br_main",
      eventId: "evt_9",
      kind: "email",
      name: "customer-email",
      contentType: "text/markdown",
      content: "Subject: Your refund\n\nHi Jordan",
      createdAt: "2026-09-02T12:00:00.000Z",
    };
    const report = {
      ...email,
      id: "art_2",
      eventId: null,
      kind: "report",
      name: "summary",
      contentType: "application/json",
      content: { total: 480 },
    };
    const api = fakeApi({
      "GET /api/v1/traces/trc_1/artifacts": () => ({ body: { items: [email, report] } }),
      "GET /api/v1/traces/trc_1/artifacts/art_1": () => ({ body: email }),
      "GET /api/v1/traces/trc_1/artifacts/art_2": () => ({ body: report }),
    });
    expect(await runWith(api, ["artifacts", "list", "trc_1", "--event", "evt_9"])).toBe(0);
    expect(new URL(api.captured.calls[0]?.url ?? "").searchParams.get("eventId")).toBe("evt_9");
    const text = api.captured.out.join("\n");
    expect(text).toContain("art_1");
    expect(text).toContain("customer-email");
    expect(text).toContain("2 artifact(s)");

    api.captured.out.length = 0;
    expect(await runWith(api, ["artifacts", "get", "trc_1", "art_1"])).toBe(0);
    expect(api.captured.out.join("\n")).toBe(email.content);

    api.captured.out.length = 0;
    expect(await runWith(api, ["artifacts", "get", "trc_1", "art_2"])).toBe(0);
    expect(JSON.parse(api.captured.out.join("\n"))).toEqual({ total: 480 });

    const dir = await mkdtemp(path.join(tmpdir(), "shadow-cli-"));
    const file = path.join(dir, "email.md");
    expect(await runWith(api, ["artifacts", "get", "trc_1", "art_1", "--out", file])).toBe(0);
    expect(await readFile(file, "utf8")).toBe(email.content);
    expect(api.captured.out.at(-1)).toContain(`wrote customer-email (text/markdown) to ${file}`);

    const empty = fakeApi({
      "GET /api/v1/traces/trc_1/artifacts": () => ({ body: { items: [] } }),
    });
    expect(await runWith(empty, ["artifacts", "list", "trc_1", "--json"])).toBe(0);
    expect(JSON.parse(empty.captured.out.join("\n"))).toEqual({ items: [] });
  });

  it("deletes traces only with --yes and reports partial failures", async () => {
    const api = fakeApi({
      "DELETE /api/v1/traces/trc_1": () => ({ status: 204, body: null }),
      "DELETE /api/v1/traces/trc_2": () => ({ status: 204, body: null }),
    });
    expect(await runWith(api, ["traces", "delete", "trc_1"])).toBe(2);
    expect(api.captured.calls).toHaveLength(0);
    expect(api.captured.err.join("\n")).toContain("--yes");

    expect(await runWith(api, ["traces", "delete", "trc_1", "trc_2", "--yes"])).toBe(0);
    expect(api.captured.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "DELETE /api/v1/traces/trc_1",
      "DELETE /api/v1/traces/trc_2",
    ]);
    expect(api.captured.out).toEqual(["deleted trc_1", "deleted trc_2"]);

    const partial = fakeApi({
      "DELETE /api/v1/traces/trc_1": () => ({ status: 204, body: null }),
    });
    expect(await runWith(partial, ["traces", "delete", "trc_1", "trc_missing", "--yes"])).toBe(1);
    expect(partial.captured.out).toEqual(["deleted trc_1"]);
    expect(partial.captured.err.join("\n")).toContain("trc_missing");
    expect(partial.captured.err.join("\n")).toContain("1 of 2");

    const missing = fakeApi({});
    expect(await runWith(missing, ["traces", "delete", "trc_missing", "--yes"])).toBe(4);
  });

  it("parses absolute and relative prune cutoffs", () => {
    const now = new Date("2026-09-11T12:00:00.000Z");
    expect(parseCutoff("30d", now)).toBe("2026-08-12T12:00:00.000Z");
    expect(parseCutoff("12h", now)).toBe("2026-09-11T00:00:00.000Z");
    expect(parseCutoff("45m", now)).toBe("2026-09-11T11:15:00.000Z");
    expect(parseCutoff("2w", now)).toBe("2026-08-28T12:00:00.000Z");
    expect(parseCutoff("2026-01-01", now)).toBe("2026-01-01T00:00:00.000Z");
    expect(parseCutoff("2026-03-01T10:00:00+02:00", now)).toBe("2026-03-01T08:00:00.000Z");
    expect(() => parseCutoff("yesterday", now)).toThrow(/relative age/);
  });

  it("prunes traces only with --yes and previews with --dry-run", async () => {
    const api = fakeApi({
      "POST /api/v1/traces/prune": (body) => {
        const b = body as { dryRun: boolean };
        return {
          body: {
            dryRun: b.dryRun,
            matched: 2,
            traceIds: ["trc_old1", "trc_old2"],
            truncated: true,
          },
        };
      },
    });
    expect(await runWith(api, ["traces", "prune", "--before", "2026-06-01"])).toBe(2);
    expect(api.captured.err.join("\n")).toContain("--yes");
    expect(api.captured.calls).toHaveLength(0);

    expect(
      await runWith(api, [
        "traces",
        "prune",
        "--before",
        "2026-06-01",
        "--dry-run",
        "--tag",
        "old",
      ]),
    ).toBe(0);
    expect(api.captured.calls[0]?.body).toEqual({
      before: "2026-06-01T00:00:00.000Z",
      tag: "old",
      limit: 1000,
      dryRun: true,
    });
    const text = api.captured.out.join("\n");
    expect(text).toContain("would delete 2 trace(s)");
    expect(text).toContain("trc_old2");
    expect(text).toContain("raise --limit");

    api.captured.out.length = 0;
    expect(
      await runWith(api, ["traces", "prune", "--before", "30d", "--yes", "--limit", "5", "--json"]),
    ).toBe(0);
    const sent = api.captured.calls[1]?.body as { before: string; dryRun: boolean; limit: number };
    expect(sent.dryRun).toBe(false);
    expect(sent.limit).toBe(5);
    expect(Date.now() - new Date(sent.before).getTime()).toBeGreaterThan(29 * 86_400_000);
    expect(JSON.parse(api.captured.out.join("\n")).matched).toBe(2);

    const invalid = fakeApi({});
    expect(await runWith(invalid, ["traces", "prune", "--before", "soon", "--yes"])).toBe(2);
  });

  it("archives bundles before deleting when pruning with --archive", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "shadow-archive-"));
    const bundle = (id: string) => ({
      format: "shadow.trace",
      trace: { ...trace, id },
      branches: [],
      events: [],
      forks: [],
      replays: [],
      comparisons: [],
    });
    const api = fakeApi({
      "POST /api/v1/traces/prune": (body) => {
        expect((body as { dryRun: boolean }).dryRun).toBe(true);
        return {
          body: { dryRun: true, matched: 2, traceIds: ["trc_a", "trc_b"], truncated: false },
        };
      },
      "GET /api/v1/traces/trc_a/export": () => ({ body: bundle("trc_a") }),
      "GET /api/v1/traces/trc_b/export": () => ({ body: bundle("trc_b") }),
      "DELETE /api/v1/traces/trc_a": () => ({ status: 204, body: null }),
      "DELETE /api/v1/traces/trc_b": () => ({ status: 204, body: null }),
    });
    expect(
      await runWith(api, ["traces", "prune", "--before", "2026-01-01", "--archive", dir, "--yes"]),
    ).toBe(0);
    const order = api.captured.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`);
    expect(order).toEqual([
      "POST /api/v1/traces/prune",
      "GET /api/v1/traces/trc_a/export",
      "DELETE /api/v1/traces/trc_a",
      "GET /api/v1/traces/trc_b/export",
      "DELETE /api/v1/traces/trc_b",
    ]);
    const saved = JSON.parse(await readFile(path.join(dir, "trc_b.shadow.json"), "utf8"));
    expect(saved.trace.id).toBe("trc_b");
    const text = api.captured.out.join("\n");
    expect(text).toContain("deleted 2 trace(s)");
    expect(text).toContain(`archived 2 bundle(s) to ${dir}`);

    // An export failure stops before anything is deleted.
    const failing = fakeApi({
      "POST /api/v1/traces/prune": () => ({
        body: { dryRun: true, matched: 1, traceIds: ["trc_gone"], truncated: false },
      }),
    });
    expect(
      await runWith(failing, [
        "traces",
        "prune",
        "--before",
        "2026-01-01",
        "--archive",
        dir,
        "--yes",
      ]),
    ).toBe(4);
    expect(failing.captured.calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("creates forks with typed overrides, replays and compares", async () => {
    const fork = {
      id: "frk_1",
      traceId: "trc_1",
      parentBranchId: "br_main",
      childBranchId: "br_fork",
      forkEventId: "evt_35",
      forkSequence: 34,
      overrides: [],
      createdAt: trace.createdAt,
      metadata: {},
    };
    const child = {
      ...branch,
      id: "br_fork",
      name: "fork-1",
      parentBranchId: "br_main",
      forkId: "frk_1",
      forkEventId: "evt_35",
      forkSequence: 34,
      status: "pending",
      outcome: null,
    };
    const replay = {
      id: "rpl_1",
      traceId: "trc_1",
      branchId: "br_fork",
      forkId: "frk_1",
      mode: "deterministic",
      status: "completed",
      startedAt: trace.createdAt,
      completedAt: trace.createdAt,
      eventCount: 22,
      error: null,
      metadata: {},
    };
    const api = fakeApi({
      "POST /api/v1/traces/trc_1/forks": () => ({ status: 201, body: { branch: child, fork } }),
      "POST /api/v1/branches/br_fork/replay": () => ({
        status: 201,
        body: {
          replay,
          branch: {
            ...child,
            status: "completed",
            outcome: { kind: "approval_pending", label: "Approval requested" },
          },
        },
      }),
      "POST /api/v1/comparisons": () => ({
        status: 201,
        body: {
          id: "cmp_1",
          traceId: "trc_1",
          baseBranchId: "br_main",
          targetBranchId: "br_fork",
          createdAt: trace.createdAt,
          result: {
            base: { name: "main" },
            target: { name: "fork-1" },
            outcome: {
              base: trace.outcome,
              target: { kind: "approval_pending", label: "Approval requested" },
              changed: true,
            },
            metrics: {
              totalEstimatedCost: { base: 0.0048, target: 0.0028, delta: -0.002, percent: -0.41 },
              durationMs: { base: 4710, target: 3810, delta: -900, percent: -0.19 },
              totalTokens: { base: 623, target: 625, delta: 2, percent: 0.003 },
              toolCalls: { base: 6, target: 6, delta: 0, percent: 0 },
              modelCalls: { base: 4, target: 4, delta: 0, percent: 0 },
            },
            policy: {
              base: { allow: 1, deny: 1, approval_required: 0 },
              target: { allow: 1, deny: 0, approval_required: 1 },
              changed: true,
            },
            firstDivergence: {
              sequence: 36,
              summary: "policy.evaluated 'refund.autonomous_limit': output.decision changed",
              fields: [{ path: "output.decision", before: "allow", after: "approval_required" }],
            },
            addedEvents: [1],
            removedEvents: [],
            modifiedEvents: [1, 2],
          },
        },
      }),
    });
    expect(
      await runWith(api, [
        "fork",
        "trc_1",
        "--at",
        "evt_35",
        "--set",
        "refundLimit=100",
        "--tool-error",
        "send_email=smtp down",
        "--replay",
      ]),
    ).toBe(0);
    const forkBody = api.captured.calls[0]?.body as { overrides: unknown[]; forkEventId: string };
    expect(forkBody.forkEventId).toBe("evt_35");
    expect(forkBody.overrides).toEqual([
      { kind: "context", op: "set", key: "refundLimit", value: 100 },
      { kind: "tool_error", tool: "send_email", occurrence: 1, error: { message: "smtp down" } },
    ]);
    expect(api.captured.out.join("\n")).toContain("replay rpl_1 completed");

    expect(await runWith(api, ["replay", "br_fork"])).toBe(0);
    expect(await runWith(api, ["compare", "br_main", "br_fork"])).toBe(0);
    const text = api.captured.out.join("\n");
    expect(text).toContain("first divergence at sequence 36");
    expect(text).toContain("Approval requested");
    expect(text).toContain("-41.0%");
  });
});
