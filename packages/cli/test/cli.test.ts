import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { money, parseCutoff } from "../src/format.js";
import { CLI_VERSION, run } from "../src/index.js";

interface Captured {
  out: string[];
  err: string[];
  calls: { method: string; url: string; body?: unknown; headers?: Record<string, string> }[];
}

function fakeApi(
  routes: Record<
    string,
    (body: unknown) => { status?: number; body: unknown; raw?: boolean; contentType?: string }
  >,
): {
  fetch: typeof fetch;
  captured: Captured;
} {
  const captured: Captured = { out: [], err: [], calls: [] };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const rawBody =
      init?.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : init?.body;
    const body = rawBody ? JSON.parse(String(rawBody)) : undefined;
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
    // `raw` answers with the body text as is (CSV, Markdown); otherwise JSON.
    return new Response(result.raw ? String(result.body) : JSON.stringify(result.body), {
      status: result.status ?? 200,
      headers: { "content-type": result.contentType ?? "application/json" },
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
          agents: { replayable: ["inventory-agent", "refund-agent"] },
          features: {
            auth: true,
            retention: { enabled: true, days: 30, intervalMinutes: 60 },
            sampling: { enabled: true, rate: 0.2 },
            otlp: {
              path: "/api/v1/otlp/v1/traces",
              defaultProject: "otel",
              export: { enabled: true, encoding: "protobuf" },
            },
            webhook: { enabled: true, events: "all", format: "slack" },
            fileExport: { enabled: true, dir: "/var/lib/shadow/export" },
          },
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
    expect(text).toContain("replay    inventory-agent, refund-agent");
    expect(text).toContain(
      "auth required; retention 30d every 60m; sampling 20% of traces; otlp at /api/v1/otlp/v1/traces; otlp export on (protobuf); webhook on (all, slack); file export to /var/lib/shadow/export",
    );
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
    // Older APIs without the agents/features fields still work.
    const older = fakeApi({
      "GET /health": () => ({
        body: {
          status: "ok",
          version: "0.1.0",
          uptimeSeconds: 1,
          database: { kind: "pglite", location: "pglite:memory", healthy: true },
        },
      }),
      "GET /api/v1/traces": () => ({ body: { items: [], nextCursor: null, total: 0 } }),
      "GET /api/v1/traces/facets": () => ({
        body: { projects: [], agents: [], tags: [], tools: [] },
      }),
    });
    expect(await runWith(older, ["status"])).toBe(0);
    expect(older.captured.out.join("\n")).toContain("no replayable agents registered");
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

    const ranged = fakeApi({
      "GET /api/v1/traces": () => ({ body: { items: [], nextCursor: null, total: 0 } }),
    });
    expect(
      await runWith(ranged, [
        "traces",
        "list",
        "--from",
        "2026-09-01",
        "--to",
        "2026-09-02T00:00:00Z",
        "--min-cost",
        "0.5",
        "--min-duration",
        "1500",
        "--sort",
        "totalEstimatedCost",
        "--order",
        "asc",
        "--meta",
        "customerId=cus_1001",
      ]),
    ).toBe(0);
    const params = new URL(ranged.captured.calls[0]?.url ?? "").searchParams;
    expect(params.get("meta")).toBe("customerId=cus_1001");
    expect(params.get("from")).toBe("2026-09-01T00:00:00.000Z");
    expect(params.get("to")).toBe("2026-09-02T00:00:00.000Z");
    expect(params.get("minCost")).toBe("0.5");
    expect(params.get("minDurationMs")).toBe("1500");
    expect(params.get("sort")).toBe("totalEstimatedCost");
    expect(params.get("order")).toBe("asc");
    expect(ranged.captured.out.join("\n")).toContain("no traces found");

    const sheet = fakeApi({
      "GET /api/v1/traces": () => ({
        raw: true,
        contentType: "text/csv; charset=utf-8",
        body: "id,name,project\r\ntrc_1,refund-request,support\r\n",
      }),
    });
    expect(await runWith(sheet, ["traces", "list", "--csv", "--tag", "refund"])).toBe(0);
    const csvParams = new URL(sheet.captured.calls[0]?.url ?? "").searchParams;
    expect(csvParams.get("format")).toBe("csv");
    expect(csvParams.get("tag")).toBe("refund");
    expect(csvParams.get("limit")).toBeNull();
    expect(sheet.captured.out.join("\n")).toBe("id,name,project\r\ntrc_1,refund-request,support");
    const sheetFile = path.join(await mkdtemp(path.join(tmpdir(), "shadow-cli-csv-")), "t.csv");
    expect(await runWith(sheet, ["traces", "list", "--out", sheetFile])).toBe(0);
    expect(await readFile(sheetFile, "utf8")).toContain("trc_1,refund-request");
    expect(sheet.captured.out.join("\n")).toContain(`wrote 1 trace to ${sheetFile}`);

    const relative = fakeApi({
      "GET /api/v1/traces": () => ({ body: { items: [], nextCursor: null, total: 0 } }),
    });
    expect(await runWith(relative, ["traces", "list", "--from", "7d"])).toBe(0);
    const from = new URL(relative.captured.calls[0]?.url ?? "").searchParams.get("from") ?? "";
    expect(Date.now() - Date.parse(from)).toBeGreaterThan(6.9 * 86_400_000);
    expect(await runWith(fakeApi({}), ["traces", "list", "--sort", "cost"])).toBe(2);
    expect(await runWith(fakeApi({}), ["traces", "list", "--min-cost", "-1"])).toBe(2);
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

  it("tails a running trace until it finishes, reading only what is new", async () => {
    let polls = 0;
    const api = fakeApi({
      "GET /api/v1/traces/trc_1": () => {
        polls++;
        return {
          body: {
            trace: { ...trace, status: polls < 3 ? "running" : "completed", outcome: null },
            branches: [branch],
          },
        };
      },
      "GET /api/v1/traces/trc_1/events": () => ({
        body: {
          // Each poll sees one more event; earlier events are repeated and must not reprint.
          items: [
            ev(0, "trace.started", "refund-request"),
            ev(1, "tool.request", "read_customer", { spanId: "spn_1" }),
            ...(polls >= 2 ? [ev(2, "tool.response", "read_customer", { durationMs: 120 })] : []),
          ].slice(0, polls + 1),
          nextCursor: null,
        },
      }),
    });
    expect(await runWith(api, ["traces", "tail", "trc_1", "--interval", "1"])).toBe(0);
    const text = api.captured.out.join("\n");
    expect(text).toContain("following trc_1 (refund-request) on branch br_main; status running");
    expect(text.match(/trace\.started/g)).toHaveLength(1);
    expect(text.match(/tool\.request/g)).toHaveLength(1);
    expect(text).toMatch(/2 {2}tool\.response {14}read_customer {2}120ms/);
    expect(text).toContain("trace completed after 4.71s; 3 events on br_main");
    // Two polls (the trace finished on the third status check); the second continues from
    // the last sequence seen.
    const eventCalls = api.captured.calls.filter((c) => c.url.includes("/events"));
    expect(eventCalls).toHaveLength(2);
    const second = new URL(eventCalls[1]?.url ?? "").searchParams;
    expect(second.get("afterSequence")).toBe("1");
    expect(second.get("cursor")).toBeNull();
    expect(new URL(eventCalls[0]?.url ?? "").searchParams.get("afterSequence")).toBeNull();

    // --new skips what was already recorded; --json prints one line per event.
    polls = 0;
    api.captured.out.length = 0;
    expect(
      await runWith(api, ["traces", "tail", "trc_1", "--interval", "1", "--new", "--json"]),
    ).toBe(0);
    const lines = api.captured.out.map((l) => JSON.parse(l) as { sequence: number });
    expect(lines.map((l) => l.sequence)).toEqual([2]);
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
      schemaVersion: "1.0",
      exportedAt: "2026-09-01T10:00:00.000Z",
      project: { slug: "support-agent", name: "Support Agent", description: null, metadata: {} },
      agent: { slug: "refund-agent", name: "Refund Agent", description: null, metadata: {} },
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
    // Several ids go through the bulk route: one file per trace, or newline-delimited JSON.
    const many = fakeApi({
      "POST /api/v1/traces/export": () => ({
        raw: true,
        contentType: "application/x-ndjson; charset=utf-8",
        body: `${JSON.stringify(bundle)}\n${JSON.stringify({ ...bundle, trace: { ...bundle.trace, id: "trc_2" } })}\n`,
      }),
    });
    const outDir = path.join(dir, "many");
    expect(
      await runWith(many, ["traces", "export", "trc_1", "trc_2", "trc_3", "--out", outDir]),
    ).toBe(0);
    expect(many.captured.calls[0]?.method).toBe("POST");
    expect(many.captured.calls[0]?.body).toEqual({ traceIds: ["trc_1", "trc_2", "trc_3"] });
    expect(JSON.parse(await readFile(path.join(outDir, "trc_2.json"), "utf8"))).toMatchObject({
      trace: { id: "trc_2" },
    });
    expect(many.captured.out.at(-1)).toContain("wrote 2 bundle(s) to");
    expect(many.captured.out.at(-1)).toContain("(1 not found)");
    expect(await runWith(many, ["traces", "export", "trc_1", "trc_2", "--markdown"])).toBe(2);
    expect(await runWith(api, ["traces", "export", "trc_1", "--markdown"])).toBe(0);
    expect(api.captured.out.at(-1)).toContain("## Execution");
    expect(api.captured.out.at(-1)?.startsWith("# ")).toBe(true);
    const report = path.join(dir, "trace.md");
    expect(
      await runWith(api, [
        "traces",
        "export",
        "trc_1",
        "--markdown",
        "--out",
        report,
        "--max-events",
        "1",
      ]),
    ).toBe(0);
    expect(await readFile(report, "utf8")).toContain("| Trace | `trc_1` |");
    expect(api.captured.out.at(-1)).toContain("wrote a report of 1 events");
    expect(await runWith(api, ["traces", "import", file, "--regenerate-ids"])).toBe(0);
    expect(api.captured.out.at(-1)).toContain("imported trace trc_copy");
    expect((api.captured.calls.at(-1)?.body as { idStrategy: string }).idStrategy).toBe(
      "regenerate",
    );
    await writeFile(file, "not json");
    expect(await runWith(api, ["traces", "import", file])).toBe(2);
  });

  it("imports a directory of bundles, skipping what exists and what is not a bundle", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "shadow-cli-dir-"));
    await mkdir(path.join(dir, "support"), { recursive: true });
    const bundleFor = (id: string) => ({
      format: "shadow.trace",
      trace: { ...trace, id },
      branches: [branch],
      events: [ev(0, "trace.started", "x")],
      forks: [],
      replays: [],
      comparisons: [],
    });
    await writeFile(
      path.join(dir, "support", "trc_new.json"),
      JSON.stringify(bundleFor("trc_new")),
    );
    await writeFile(
      path.join(dir, "support", "trc_old.json"),
      JSON.stringify(bundleFor("trc_old")),
    );
    await writeFile(
      path.join(dir, "support", "trc_bad.json"),
      JSON.stringify(bundleFor("trc_bad")),
    );
    await writeFile(path.join(dir, "notes.json"), JSON.stringify({ hello: "world" }));
    await writeFile(path.join(dir, "readme.txt"), "ignored");
    await writeFile(path.join(dir, "broken.json"), "{");
    const api = fakeApi({
      "POST /api/v1/traces/import": (body) => {
        const id = (body as { bundle: { trace: { id: string } } }).bundle.trace.id;
        if (id === "trc_old") {
          return {
            status: 409,
            body: { error: { code: "conflict", message: `trace ${id} already exists` } },
          };
        }
        if (id === "trc_bad") {
          return { status: 422, body: { error: { code: "invalid", message: "bad bundle" } } };
        }
        return { status: 201, body: { id, branchCount: 1 } };
      },
    });
    expect(await runWith(api, ["traces", "import", dir])).toBe(1);
    const text = api.captured.out.join("\n");
    expect(text).toContain("imported support/trc_new.json (trc_new)");
    expect(text).toContain("exists   support/trc_old.json (trc_old)");
    expect(text).toContain("failed   support/trc_bad.json: bad bundle");
    expect(text).toContain("skipped  notes.json: not a shadow.trace bundle");
    expect(text).toContain("failed   broken.json: could not read");
    expect(text).toContain("imported 1 of 5 bundle(s); 1 already present, 1 skipped, 2 failed");
    expect(text).not.toContain("readme.txt");
    expect(api.captured.calls).toHaveLength(3);

    const clean = fakeApi({
      "POST /api/v1/traces/import": (body) => ({
        status: 201,
        body: {
          id: (body as { bundle: { trace: { id: string } } }).bundle.trace.id,
          branchCount: 1,
        },
      }),
    });
    const only = await mkdtemp(path.join(tmpdir(), "shadow-cli-dir-"));
    await writeFile(path.join(only, "a.json"), JSON.stringify(bundleFor("trc_a")));
    expect(await runWith(clean, ["traces", "import", only, "--json", "--regenerate-ids"])).toBe(0);
    const summary = JSON.parse(clean.captured.out.join("\n")) as {
      imported: number;
      failed: number;
    };
    expect(summary).toMatchObject({ files: 1, imported: 1, exists: 0, skipped: 0, failed: 0 });
    expect((clean.captured.calls[0]?.body as { idStrategy: string }).idStrategy).toBe("regenerate");
    const empty = await mkdtemp(path.join(tmpdir(), "shadow-cli-empty-"));
    expect(await runWith(clean, ["traces", "import", empty])).toBe(2);
  });

  it("exports a collection as bundles and imports a .ndjson file of them", async () => {
    const bundleLine = (id: string) =>
      JSON.stringify({
        format: "shadow.trace",
        trace: { ...trace, id },
        branches: [branch],
        events: [ev(0, "trace.started", "x")],
        forks: [],
        replays: [],
        comparisons: [],
      });
    const ndjson = `${bundleLine("trc_1")}\n${bundleLine("trc_2")}\n`;
    const api = fakeApi({
      "GET /api/v1/collections/incident-42/export": () => ({
        raw: true,
        contentType: "application/x-ndjson; charset=utf-8",
        body: ndjson,
      }),
      "POST /api/v1/traces/import": (body) => {
        const id = (body as { bundle: { trace: { id: string } } }).bundle.trace.id;
        return id === "trc_2"
          ? { status: 409, body: { error: { code: "conflict", message: "exists" } } }
          : { status: 201, body: { id, branchCount: 1 } };
      },
    });
    const dir = await mkdtemp(path.join(tmpdir(), "shadow-cli-col-"));
    expect(await runWith(api, ["collections", "export", "incident-42", "--out", dir])).toBe(0);
    expect(api.captured.out.join("\n")).toContain(`wrote 2 bundle(s) of incident-42 to ${dir}`);
    expect(JSON.parse(await readFile(path.join(dir, "trc_1.json"), "utf8"))).toMatchObject({
      trace: { id: "trc_1" },
    });
    expect(JSON.parse(await readFile(path.join(dir, "trc_2.json"), "utf8"))).toMatchObject({
      trace: { id: "trc_2" },
    });
    const file = path.join(dir, "all.ndjson");
    expect(await runWith(api, ["collections", "export", "incident-42", "--out", file])).toBe(0);
    expect(await readFile(file, "utf8")).toBe(ndjson);
    api.captured.out.length = 0;
    expect(await runWith(api, ["collections", "export", "incident-42"])).toBe(0);
    expect(api.captured.out.join("\n").split("\n")).toHaveLength(2);

    // The .ndjson file imports line by line, with the same statuses as a directory.
    await writeFile(file, `${ndjson}{not json\n`);
    api.captured.out.length = 0;
    expect(await runWith(api, ["traces", "import", file])).toBe(1);
    const text = api.captured.out.join("\n");
    expect(text).toContain("imported line 1 (trc_1)");
    expect(text).toContain("exists   line 2 (trc_2)");
    expect(text).toContain("failed   line 3: could not parse");
    expect(text).toContain("imported 1 of 3 bundle(s); 1 already present, 0 skipped, 1 failed");
    expect(api.captured.calls.filter((c) => c.url.endsWith("/traces/import"))).toHaveLength(2);
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

  it("adds notes and documents as artifacts", async () => {
    const api = fakeApi({
      "POST /api/v1/traces/trc_1/artifacts": (body) => ({
        status: 201,
        body: {
          id: "art_9",
          traceId: "trc_1",
          branchId: "br_main",
          eventId: (body as { eventId?: string }).eventId ?? null,
          kind: (body as { kind: string }).kind,
          name: (body as { name: string }).name,
          contentType: (body as { contentType: string }).contentType,
          content: (body as { content: unknown }).content,
          createdAt: "2026-09-02T12:00:00.000Z",
        },
      }),
    });
    expect(
      await runWith(api, [
        "artifacts",
        "add",
        "trc_1",
        "--kind",
        "note",
        "--event",
        "evt_7",
        "--content",
        "stale policy doc",
      ]),
    ).toBe(0);
    expect(api.captured.calls[0]?.body).toEqual({
      kind: "note",
      name: "note",
      eventId: "evt_7",
      contentType: "text/plain",
      content: "stale policy doc",
    });
    expect(api.captured.out.at(-1)).toContain("stored note art_9 (text/plain) on event evt_7");

    const dir = await mkdtemp(path.join(tmpdir(), "shadow-artifact-"));
    const file = path.join(dir, "report.json");
    await writeFile(file, JSON.stringify({ total: 480 }));
    expect(
      await runWith(api, [
        "artifacts",
        "add",
        "trc_1",
        "--kind",
        "report",
        "--name",
        "totals",
        "--file",
        file,
        "--json",
      ]),
    ).toBe(0);
    expect(api.captured.calls[1]?.body).toEqual({
      kind: "report",
      name: "totals",
      contentType: "application/json",
      content: { total: 480 },
    });
    expect(JSON.parse(api.captured.out.at(-1) ?? "{}").id).toBe("art_9");

    expect(await runWith(fakeApi({}), ["artifacts", "add", "trc_1", "--kind", "note"])).toBe(2);

    const removal = fakeApi({
      "DELETE /api/v1/traces/trc_1/artifacts/art_1": () => ({ status: 204, body: null }),
    });
    expect(await runWith(removal, ["artifacts", "remove", "trc_1", "art_1"])).toBe(0);
    expect(removal.captured.calls[0]?.method).toBe("DELETE");
    expect(removal.captured.out.join("\n")).toContain("deleted artifact art_1");
    expect(await runWith(fakeApi({}), ["artifacts", "remove", "trc_1", "art_gone"])).toBe(4);
    expect(
      await runWith(fakeApi({}), [
        "artifacts",
        "add",
        "trc_1",
        "--kind",
        "note",
        "--content",
        "a",
        "--file",
        file,
      ]),
    ).toBe(2);
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

  it("formats money including negative deltas and other currencies", () => {
    expect(money(0)).toBe("$0");
    expect(money(0.0048)).toBe("$0.004800");
    expect(money(1.5)).toBe("$1.5000");
    expect(money(-0.001995)).toBe("-$0.001995");
    expect(money(-2)).toBe("-$2.0000");
    expect(money(3, "EUR")).toBe("EUR 3.0000");
    expect(money(null)).toBe("-");
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
      excludeTag: "keep",
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

    const everything = fakeApi({
      "POST /api/v1/traces/prune": () => ({
        body: { dryRun: true, matched: 0, traceIds: [], truncated: false },
      }),
    });
    expect(
      await runWith(everything, [
        "traces",
        "prune",
        "--before",
        "1d",
        "--dry-run",
        "--exclude-tag",
        "",
        "--keep-collected",
      ]),
    ).toBe(0);
    expect(everything.captured.calls[0]?.body).not.toHaveProperty("excludeTag");
    expect(everything.captured.calls[0]?.body).toMatchObject({ keepCollected: true });
    expect(Date.now() - new Date(sent.before).getTime()).toBeGreaterThan(29 * 86_400_000);
    expect(JSON.parse(api.captured.out.join("\n")).matched).toBe(2);

    const invalid = fakeApi({});
    expect(await runWith(invalid, ["traces", "prune", "--before", "soon", "--yes"])).toBe(2);
  });

  it("imports OTLP JSON files, including newline-delimited exports", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "shadow-otlp-"));
    const single = path.join(dir, "one.json");
    const ndjson = path.join(dir, "many.ndjson");
    const bad = path.join(dir, "bad.ndjson");
    await writeFile(single, JSON.stringify({ resourceSpans: [{ id: 1 }] }));
    await writeFile(
      ndjson,
      `${JSON.stringify({ resourceSpans: [{ id: 2 }] })}\n\n${JSON.stringify({ resourceSpans: [{ id: 3 }] })}\n`,
    );
    await writeFile(bad, '{"resourceSpans":[]}\nnot json\n');
    let calls = 0;
    const api = fakeApi({
      "POST /api/v1/otlp/v1/traces": (body) => {
        calls++;
        const id = (body as { resourceSpans: { id: number }[] }).resourceSpans[0]?.id;
        return {
          body: {
            partialSuccess: {},
            shadow: {
              traces: [
                {
                  traceId: `trc_otel_${id}`,
                  otelTraceId: String(id),
                  created: id !== 3,
                  accepted: 4,
                  skipped: id === 3 ? 2 : 0,
                },
              ],
            },
          },
        };
      },
    });
    expect(await runWith(api, ["otlp", "import", single, ndjson])).toBe(0);
    expect(calls).toBe(3);
    const text = api.captured.out.join("\n");
    expect(text).toContain("created  trc_otel_1: 4 event(s)");
    expect(text).toContain("extended trc_otel_3: 4 event(s), 2 already stored");
    expect(text).toContain(
      "imported 3 request(s) from 2 file(s): 2 trace(s) created, 1 extended, 12 event(s) stored",
    );

    expect(await runWith(fakeApi({}), ["otlp", "import", bad])).toBe(2);
  });

  it("creates, lists and revokes API keys", async () => {
    const key = {
      id: "key_1",
      name: "ci-ingest",
      scope: "ingest",
      prefix: "shk_abcdefgh",
      createdAt: "2026-10-04T09:00:00.000Z",
      lastUsedAt: null,
      revokedAt: null,
      expiresAt: null,
    };
    const expired = {
      ...key,
      id: "key_2",
      name: "old-reader",
      scope: "read",
      expiresAt: "2026-10-05T09:00:00.000Z",
    };
    const api = fakeApi({
      "POST /api/v1/keys": (body) => ({
        status: 201,
        body: { key: { ...key, ...(body as object) }, secret: "shk_abcdefghSECRET" },
      }),
      "GET /api/v1/keys": () => ({
        body: {
          items: [
            key,
            expired,
            {
              ...key,
              id: "key_9",
              name: "soon",
              expiresAt: new Date(Date.now() + 2.5 * 86_400_000).toISOString(),
            },
          ],
        },
      }),
      "DELETE /api/v1/keys/ci-ingest": () => ({
        body: { ...key, revokedAt: "2026-10-04T10:00:00.000Z" },
      }),
      "POST /api/v1/keys/ci-ingest/rotate": () => ({
        status: 201,
        body: {
          key: { ...key, id: "key_3", prefix: "shk_newprefi" },
          secret: "shk_newprefixSECRET",
          retired: {
            ...key,
            name: "ci-ingest:rotated:20261004T1000",
            revokedAt: "2026-10-04T10:00:00.000Z",
          },
        },
      }),
    });
    expect(await runWith(api, ["keys", "create", "ci-ingest", "--scope", "ingest"])).toBe(0);
    expect(api.captured.calls[0]?.body).toEqual({ name: "ci-ingest", scope: "ingest" });
    expect(api.captured.out[0]).toBe("shk_abcdefghSECRET");
    expect(api.captured.out.join("\n")).toContain("cannot be shown again");
    expect(await runWith(api, ["keys", "list"])).toBe(0);
    expect(api.captured.out.join("\n")).toMatch(
      /key_1\s+ci-ingest\s+ingest\s+any\s+shk_abcdefgh…\s+active\s+never/,
    );
    expect(api.captured.out.join("\n")).toMatch(
      /key_2\s+old-reader\s+read\s+any\s+shk_abcdefgh…\s+expired 2026-10-05T09:00:00.000Z/,
    );
    // A key about to expire is called out in its row and after the table.
    expect(api.captured.out.join("\n")).toMatch(
      /key_9\s+soon\s+ingest\s+any\s+shk_abcdefgh…\s+expires in 3d/,
    );
    expect(api.captured.out.join("\n")).toContain(
      "1 key(s) expire within 7 days: soon. Rotate them with: shadow keys rotate <name>",
    );
    expect(await runWith(api, ["keys", "create", "short-lived", "--expires", "30"])).toBe(0);
    expect(api.captured.calls.at(-1)?.body).toEqual({
      name: "short-lived",
      scope: "ingest",
      expiresInDays: 30,
    });
    expect(await runWith(api, ["keys", "create", "x", "--expires", "0"])).toBe(2);
    expect(await runWith(api, ["keys", "create", "support-ingest", "--project", "support"])).toBe(
      0,
    );
    expect(api.captured.calls.at(-1)?.body).toEqual({
      name: "support-ingest",
      scope: "ingest",
      project: "support",
    });
    expect(await runWith(api, ["keys", "rotate", "ci-ingest"])).toBe(0);
    expect(api.captured.out).toContain("shk_newprefixSECRET");
    expect(api.captured.out.join("\n")).toContain(
      "rotated ci-ingest: new key key_3, previous key key_1 retired as ci-ingest:rotated:20261004T1000",
    );
    expect(await runWith(api, ["keys", "revoke", "ci-ingest"])).toBe(0);
    expect(api.captured.out.join("\n")).toContain("revoked ci-ingest (key_1)");
    expect(await runWith(api, ["keys", "create", "x", "--scope", "root"])).toBe(2);
  });

  it("prints the price table", async () => {
    const api = fakeApi({
      "GET /api/v1/pricing": () => ({
        body: {
          version: "builtin",
          items: [
            {
              provider: "anthropic",
              model: "claude-opus-5-5",
              inputPerMillion: 4,
              outputPerMillion: 20,
              cachedInputPerMillion: 0.2,
              currency: "USD",
              version: "anthropic-2026-09-25",
            },
            {
              provider: "shadow-sim",
              model: "sim-support-1",
              inputPerMillion: 2.5,
              outputPerMillion: 10,
              currency: "USD",
              version: "sim-2026.1",
            },
          ],
        },
      }),
    });
    expect(await runWith(api, ["pricing"])).toBe(0);
    const text = api.captured.out.join("\n");
    expect(text).toMatch(/anthropic\s+claude-opus-5-5\s+4\s+20\s+0\.2\s+USD/);
    expect(text).toMatch(/shadow-sim\s+sim-support-1\s+2\.5\s+10\s+-/);
    expect(text).toContain("2 model(s); prices are estimates");
    api.captured.out.length = 0;
    expect(await runWith(api, ["pricing", "--provider", "anthropic"])).toBe(0);
    expect(api.captured.out.join("\n")).not.toContain("shadow-sim");
    expect(await runWith(api, ["pricing", "--provider", "nobody"])).toBe(0);
    expect(api.captured.out.join("\n")).toContain("no prices");
  });

  it("imports an Anthropic Messages conversation from a file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "shadow-anthropic-"));
    const messages = [
      { role: "user", content: "refund ord_1" },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ];
    const bare = path.join(dir, "messages.json");
    const full = path.join(dir, "conversation.json");
    await writeFile(bare, JSON.stringify(messages));
    await writeFile(full, JSON.stringify({ agent: "from-file", tags: ["a"], messages }));
    const api = fakeApi({
      "POST /api/v1/import/anthropic": () => ({
        status: 201,
        body: {
          traceId: "trc_imported",
          name: "refund ord_1",
          events: 9,
          summary: {
            turns: 1,
            toolCalls: 1,
            serverToolCalls: 1,
            unmatchedToolUses: 1,
            orphanToolResults: 0,
            stopReason: "end_turn",
          },
        },
      }),
    });
    expect(
      await runWith(api, [
        "import",
        "anthropic",
        bare,
        "--agent",
        "claude-bot",
        "--model",
        "claude-opus-5-5",
      ]),
    ).toBe(0);
    expect(api.captured.calls[0]?.body).toEqual({
      messages,
      agent: "claude-bot",
      model: "claude-opus-5-5",
    });
    const text = api.captured.out.join("\n");
    expect(text).toContain(
      "imported trc_imported: 1 turn(s), 2 tool call(s), 9 event(s), stop reason end_turn",
    );
    expect(text).toContain("1 tool call(s) have no result in the file");

    expect(await runWith(api, ["import", "anthropic", full, "--tag", "b", "--json"])).toBe(0);
    expect(api.captured.calls[1]?.body).toEqual({ agent: "from-file", tags: ["a", "b"], messages });

    const notMessages = path.join(dir, "bad.json");
    await writeFile(notMessages, JSON.stringify({ hello: "world" }));
    expect(await runWith(api, ["import", "anthropic", notMessages])).toBe(2);
    expect(await runWith(api, ["import", "anthropic", path.join(dir, "missing.json")])).toBe(2);
  });

  it("imports an OpenAI Chat Completions conversation from a file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "shadow-cli-openai-"));
    const file = path.join(dir, "chat.json");
    await writeFile(
      file,
      JSON.stringify({
        tags: ["refund"],
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
        ],
      }),
    );
    const api = fakeApi({
      "POST /api/v1/import/openai": (body) => ({
        status: 201,
        body: {
          traceId: "trc_openai_1",
          name: "hi",
          events: 9,
          summary: {
            turns: 1,
            toolCalls: 0,
            unmatchedToolCalls: 1,
            orphanToolResults: 0,
            finishReason: (body as { model?: string }).model ? "stop" : null,
          },
        },
      }),
    });
    expect(
      await runWith(api, ["import", "openai", file, "--model", "gpt-5", "--tag", "support"]),
    ).toBe(0);
    expect(api.captured.calls[0]?.body).toMatchObject({
      model: "gpt-5",
      tags: ["refund", "support"],
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
    });
    const text = api.captured.out.join("\n");
    expect(text).toContain(
      "imported trc_openai_1: 1 turn(s), 0 tool call(s), 9 event(s), stop reason stop",
    );
    expect(text).toContain("1 tool call(s) have no result in the file");
  });

  it("sends a spool file's records in order, skipping traces that already exist", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "shadow-cli-spool-"));
    const file = path.join(dir, "run.ndjson");
    const lines = [
      JSON.stringify({
        kind: "trace",
        body: { id: "trc_new", project: "ci", agent: "a", name: "new" },
      }),
      JSON.stringify({
        kind: "events",
        traceId: "trc_new",
        events: [{ eventType: "trace.started", name: "trace.started" }],
      }),
      JSON.stringify({
        kind: "artifact",
        traceId: "trc_new",
        artifact: { kind: "report", name: "r", content: "x" },
      }),
      JSON.stringify({ kind: "update", traceId: "trc_new", update: { addTags: ["green"] } }),
      JSON.stringify({ kind: "collection", traceId: "trc_new", collection: "nightly" }),
      JSON.stringify({
        kind: "trace",
        body: { id: "trc_old", project: "ci", agent: "a", name: "old" },
      }),
      JSON.stringify({
        kind: "events",
        traceId: "trc_old",
        events: [{ eventType: "trace.started", name: "x" }],
      }),
      "{ not json",
      JSON.stringify({ kind: "events", events: [] }),
    ];
    await writeFile(file, `${lines.join("\n")}\n`);
    const api = fakeApi({
      "POST /api/v1/traces": (body) =>
        (body as { id: string }).id === "trc_old"
          ? {
              status: 409,
              body: { error: { code: "conflict", message: "trace trc_old already exists" } },
            }
          : { status: 201, body: { id: (body as { id: string }).id, rootBranchId: "br_x" } },
      "POST /api/v1/traces/trc_new/events": () => ({ status: 201, body: { accepted: 1 } }),
      "POST /api/v1/traces/trc_new/artifacts": () => ({ status: 201, body: { id: "art_1" } }),
      "PATCH /api/v1/traces/trc_new": () => ({ body: { id: "trc_new", tags: ["green"] } }),
      // The collection does not exist yet: the add answers 404 and the sender creates it.
      "POST /api/v1/collections/nightly/traces": () => ({
        status: 404,
        body: { error: { code: "not_found", message: "collection nightly not found" } },
      }),
      "POST /api/v1/collections": () => ({ status: 201, body: { collection: { id: "col_1" } } }),
    });
    expect(await runWith(api, ["spool", "send", file])).toBe(1);
    const text = api.captured.out.join("\n");
    expect(text).toContain(
      "sent 1 trace(s), 1 event(s), 1 artifact(s), 1 update(s), 1 collection add(s); 1 trace(s) already present, 2 malformed line(s), 0 failed",
    );
    expect(text).toContain(`${file}:8:`);
    expect(text).toContain(`${file}:9: not a spool record`);
    // The existing trace's events were not sent; the new trace's records went in order.
    expect(api.captured.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "POST /api/v1/traces",
      "POST /api/v1/traces/trc_new/events",
      "POST /api/v1/traces/trc_new/artifacts",
      "PATCH /api/v1/traces/trc_new",
      "POST /api/v1/collections/nightly/traces",
      "POST /api/v1/collections",
      "POST /api/v1/traces",
    ]);
    expect(api.captured.calls[5]?.body).toEqual({ name: "nightly", traceIds: ["trc_new"] });
    const clean = path.join(dir, "clean.ndjson");
    await writeFile(clean, `${lines[0]}\n${lines[1]}\n`);
    const ok = fakeApi({
      "POST /api/v1/traces": (body) => ({ status: 201, body: { id: (body as { id: string }).id } }),
      "POST /api/v1/traces/trc_new/events": () => ({ status: 201, body: { accepted: 1 } }),
    });
    expect(await runWith(ok, ["spool", "send", clean, "--json"])).toBe(0);
    expect(JSON.parse(ok.captured.out.join("\n"))).toMatchObject({
      traces: 1,
      events: 1,
      failed: 0,
    });
  });

  it("manages collections and lists traces through one", async () => {
    const collection = (traceCount: number) => ({
      id: "col_1",
      name: "incident-42",
      description: "refund incident",
      traceCount,
      createdAt: "2026-09-30T09:00:00.000Z",
      updatedAt: "2026-09-30T09:00:00.000Z",
    });
    const api = fakeApi({
      "POST /api/v1/collections": () => ({
        status: 201,
        body: { collection: collection(1), added: ["trc_1"], missing: ["trc_gone"] },
      }),
      "GET /api/v1/collections": () => ({ body: { items: [collection(2)] } }),
      "POST /api/v1/collections/incident-42/traces": () => ({
        body: { collection: collection(2), added: ["trc_2"], missing: [] },
      }),
      "DELETE /api/v1/collections/incident-42/traces/trc_2": () => ({ body: collection(1) }),
      "DELETE /api/v1/collections/incident-42": () => ({ status: 204, body: null }),
      "GET /api/v1/traces": () => ({ body: { items: [trace], nextCursor: null } }),
    });
    expect(
      await runWith(api, [
        "collections",
        "create",
        "incident-42",
        "trc_1",
        "trc_gone",
        "--description",
        "refund incident",
      ]),
    ).toBe(0);
    expect(api.captured.calls[0]?.body).toEqual({
      name: "incident-42",
      traceIds: ["trc_1", "trc_gone"],
      description: "refund incident",
    });
    expect(api.captured.out.join("\n")).toContain("not found: trc_gone");

    expect(await runWith(api, ["collections", "list", "--trace", "trc_1"])).toBe(0);
    expect(api.captured.calls.at(-1)?.url).toContain("traceId=trc_1");
    expect(api.captured.out.join("\n")).toMatch(/col_1\s+incident-42\s+2/);

    expect(await runWith(api, ["collections", "add", "incident-42", "trc_2"])).toBe(0);
    expect(api.captured.out.join("\n")).toContain(
      "added 1 trace(s) to incident-42; it now holds 2",
    );
    expect(await runWith(api, ["traces", "list", "--collection", "incident-42"])).toBe(0);
    expect(api.captured.calls.at(-1)?.url).toContain("collection=incident-42");
    expect(await runWith(api, ["collections", "remove", "incident-42", "trc_2"])).toBe(0);
    expect(await runWith(api, ["collections", "delete", "incident-42"])).toBe(0);
    expect(await runWith(api, ["collections", "delete", "unknown"])).toBe(4);
  });

  it("tests the webhook and fails when the delivery did not go through", async () => {
    const ok = fakeApi({
      "POST /api/v1/webhook/test": () => ({
        body: { delivered: true, status: 200, error: null, format: "slack", durationMs: 42 },
      }),
    });
    expect(await runWith(ok, ["webhook", "test"])).toBe(0);
    expect(ok.captured.out.join("\n")).toContain(
      "delivered as slack: the receiver answered 200 in 42ms",
    );
    const failed = fakeApi({
      "POST /api/v1/webhook/test": () => ({
        body: {
          delivered: false,
          status: 500,
          error: "the receiver answered 500",
          format: "json",
          durationMs: 7,
        },
      }),
    });
    expect(await runWith(failed, ["webhook", "test"])).toBe(1);
    expect(failed.captured.err.join("\n")).toContain(
      "not delivered (json): the receiver answered 500",
    );
    const none = fakeApi({
      "POST /api/v1/webhook/test": () => ({
        status: 409,
        body: { error: { code: "webhook_not_configured", message: "no webhook is configured" } },
      }),
    });
    expect(await runWith(none, ["webhook", "test"])).toBe(1);
    expect(none.captured.err.join("\n")).toContain("no webhook is configured");
  });

  it("manages alert rules and fails the check when one is firing", async () => {
    const rule = (state: string, lastValue: number | null) => ({
      id: "alr_1",
      name: "refund failures",
      agent: "refund-agent",
      project: null,
      tag: null,
      metric: "failure_rate",
      mode: "threshold",
      baselineWindows: 7,
      lastBaseline: null,
      threshold: 0.5,
      windowMinutes: 360,
      minTraces: 1,
      keepFiringMinutes: 0,
      enabled: true,
      state,
      lastValue,
      lastTraces: lastValue === null ? null : 4,
      lastEvaluatedAt: lastValue === null ? null : "2026-09-30T09:00:00.000Z",
      lastTriggeredAt: null,
      createdAt: "2026-09-30T08:00:00.000Z",
      updatedAt: "2026-09-30T08:00:00.000Z",
    });
    let firing = true;
    const api = fakeApi({
      "POST /api/v1/alerts/rules": (body) => ({
        status: 201,
        body: { ...rule("ok", null), ...(body as object) },
      }),
      "GET /api/v1/alerts/rules": () => ({ body: { items: [rule("firing", 0.75)] } }),
      "POST /api/v1/alerts/evaluate": () => ({
        body: {
          items: [
            firing
              ? { rule: rule("firing", 0.75), transition: "fired" }
              : { rule: rule("ok", 0.25), transition: "resolved" },
          ],
        },
      }),
      "DELETE /api/v1/alerts/rules/alr_1": () => ({ status: 204, body: null }),
    });
    expect(
      await runWith(api, [
        "alerts",
        "add",
        "refund failures",
        "--metric",
        "failure_rate",
        "--threshold",
        "0.5",
        "--agent",
        "refund-agent",
        "--window",
        "6h",
        "--keep-firing",
        "30m",
        "--tag",
        "prod",
      ]),
    ).toBe(0);
    expect(api.captured.calls[0]?.body).toEqual({
      name: "refund failures",
      metric: "failure_rate",
      threshold: 0.5,
      agent: "refund-agent",
      tag: "prod",
      windowMinutes: 360,
      minTraces: 1,
      keepFiringMinutes: 30,
    });
    expect(api.captured.out.join("\n")).toContain(
      "fires when failure_rate >= 0.5 over 360m, held for 30m",
    );
    // The hold is optional and bounded; a bare `0` switches it off.
    expect(
      await runWith(api, [
        "alerts",
        "add",
        "x",
        "--metric",
        "tool_errors",
        "--threshold",
        "1",
        "--keep-firing",
        "8d",
      ]),
    ).toBe(2);
    expect(api.captured.err.join("\n")).toContain("--keep-firing must be between 0m and 7d");
    expect(
      await runWith(api, [
        "alerts",
        "add",
        "x",
        "--metric",
        "tool_errors",
        "--threshold",
        "1",
        "--keep-firing",
        "0",
      ]),
    ).toBe(0);
    expect(api.captured.calls.at(-1)?.body).toMatchObject({ keepFiringMinutes: 0 });

    // --dry-run measures the rule instead of creating it.
    const previewApi = fakeApi({
      "POST /api/v1/alerts/preview": () => ({
        body: { value: 0.75, baseline: null, traces: 4, limit: 0.5, wouldFire: true },
      }),
    });
    expect(
      await runWith(previewApi, [
        "alerts",
        "add",
        "refund failures",
        "--metric",
        "failure_rate",
        "--threshold",
        "0.5",
        "--window",
        "6h",
        "--dry-run",
      ]),
    ).toBe(0);
    expect(previewApi.captured.calls).toHaveLength(1);
    expect(previewApi.captured.calls[0]?.body).toMatchObject({ name: "refund failures" });
    expect(previewApi.captured.out.join("\n")).toContain(
      "failure_rate is 0.75 over 360m (4 traces); limit 0.5; would fire",
    );

    expect(await runWith(api, ["alerts", "list"])).toBe(0);
    expect(api.captured.out.join("\n")).toMatch(
      /refund failures\s+firing\s+refund-agent\s+failure_rate\s+50%\s+75%/,
    );

    expect(await runWith(api, ["alerts", "check"])).toBe(1);
    expect(api.captured.err.join("\n")).toContain("firing: refund failures");
    firing = false;
    expect(await runWith(api, ["alerts", "check"])).toBe(0);
    expect(api.captured.out.join("\n")).toContain("0 of 1 rule(s) firing");

    // Baseline rules send the mode and print the multiplier next to the measured baseline.
    api.captured.out.length = 0;
    expect(
      await runWith(api, [
        "alerts",
        "add",
        "cost spike",
        "--metric",
        "total_cost",
        "--threshold",
        "3",
        "--baseline",
        "--baseline-windows",
        "14",
        "--window",
        "1d",
      ]),
    ).toBe(0);
    expect(api.captured.calls.at(-1)?.body).toEqual({
      name: "cost spike",
      metric: "total_cost",
      threshold: 3,
      mode: "baseline",
      baselineWindows: 14,
      windowMinutes: 1440,
      minTraces: 1,
    });
    expect(api.captured.out.join("\n")).toContain(
      "fires when total_cost over 1440m >= 3x its baseline (previous 14 windows)",
    );

    expect(await runWith(api, ["alerts", "remove", "refund failures"])).toBe(0);
    expect(await runWith(api, ["alerts", "remove", "nope"])).toBe(4);
    expect(
      await runWith(api, [
        "alerts",
        "add",
        "x",
        "--metric",
        "tool_errors",
        "--threshold",
        "1",
        "--window",
        "soon",
      ]),
    ).toBe(2);
  });

  it("prints an agent trend as a sparkline and a table", async () => {
    const point = (start: string, traces: number, failed: number, cost: number) => ({
      start,
      traces,
      completed: traces - failed,
      failed,
      policyViolations: failed,
      avgDurationMs: traces ? 1000 : null,
      p95DurationMs: traces ? 4700 : null,
      totalEstimatedCost: cost,
      totalTokens: traces * 600,
    });
    const api = fakeApi({
      "GET /api/v1/stats/agents/refund-agent/timeseries": () => ({
        body: {
          agent: "refund-agent",
          bucket: "day",
          from: "2026-09-01T00:00:00.000Z",
          to: "2026-09-04T00:00:00.000Z",
          points: [
            point("2026-09-01T00:00:00.000Z", 2, 1, 0.01),
            point("2026-09-02T00:00:00.000Z", 0, 0, 0),
            point("2026-09-03T00:00:00.000Z", 1, 0, 0.005),
          ],
        },
      }),
    });
    expect(
      await runWith(api, [
        "trend",
        "refund-agent",
        "--metric",
        "totalEstimatedCost",
        "--from",
        "3d",
      ]),
    ).toBe(0);
    const url = new URL(api.captured.calls[0]?.url ?? "");
    expect(url.searchParams.get("bucket")).toBe("day");
    expect(url.searchParams.get("from")).toMatch(/^\d{4}-/);
    const text = api.captured.out.join("\n");
    expect(text).toContain("█▁▅");
    expect(text).toContain("$0.0100");
    expect(text).not.toContain("2026-09-02T00:00:00.000Z  ");
    expect(await runWith(api, ["trend", "refund-agent", "--metric", "vibes"])).toBe(2);
    expect(await runWith(api, ["trend", "refund-agent", "--bucket", "week"])).toBe(2);
  });

  it("creates, lists and revokes share links and imports from one", async () => {
    const share = {
      id: "shr_1",
      traceId: "trc_1",
      note: "vendor",
      createdAt: "2026-09-28T09:00:00.000Z",
      expiresAt: "2099-09-30T09:00:00.000Z",
      revokedAt: null,
      accessCount: 2,
      lastAccessedAt: "2026-09-28T10:00:00.000Z",
    };
    const bundle = { format: "shadow.trace", trace: { id: "trc_1" }, events: [], branches: [] };
    const api = fakeApi({
      "POST /api/v1/traces/trc_1/shares": () => ({
        status: 201,
        body: { share, token: "shs_abc", path: "/api/v1/shared/shs_abc" },
      }),
      "GET /api/v1/traces/trc_1/shares": () => ({ body: { items: [share] } }),
      "DELETE /api/v1/traces/trc_1/shares/shr_1": () => ({ status: 204, body: null }),
      "GET /api/v1/shared/shs_abc": () => ({ body: bundle }),
      "GET /api/v1/shared/shs_gone": () => ({ status: 404, body: { error: { message: "x" } } }),
      "POST /api/v1/traces/import": () => ({ status: 201, body: { id: "trc_1", branchCount: 1 } }),
    });

    expect(
      await runWith(api, ["traces", "share", "trc_1", "--expires", "2d", "--note", "vendor"]),
    ).toBe(0);
    expect(api.captured.calls[0]?.body).toEqual({ expiresInHours: 48, note: "vendor" });
    const text = api.captured.out.join("\n");
    expect(text).toContain("http://shadow.test/api/v1/shared/shs_abc");
    expect(text).toContain("view it in the browser: http://localhost:3000/shared/shs_abc");
    expect(text).toContain("shadow traces unshare trc_1 shr_1");

    expect(await runWith(api, ["traces", "shares", "trc_1"])).toBe(0);
    expect(api.captured.out.join("\n")).toMatch(/shr_1\s+active\s+2099-09-30T09:00:00.000Z\s+2x/);
    expect(await runWith(api, ["traces", "unshare", "trc_1", "shr_1"])).toBe(0);

    expect(
      await runWith(api, ["traces", "import", "http://shadow.test/api/v1/shared/shs_abc"]),
    ).toBe(0);
    const shared = api.captured.calls.find((c) => c.url.endsWith("/api/v1/shared/shs_abc"));
    expect(shared?.headers).not.toHaveProperty("authorization");
    const imported = api.captured.calls.find((c) => c.url.endsWith("/api/v1/traces/import"));
    expect(imported?.body).toEqual({ bundle, idStrategy: "keep" });
    expect(
      await runWith(api, ["traces", "import", "http://shadow.test/api/v1/shared/shs_gone"]),
    ).toBe(4);

    expect(await runWith(api, ["traces", "share", "trc_1", "--expires", "forever"])).toBe(2);
    expect(await runWith(api, ["traces", "share", "trc_1", "--expires", "31d"])).toBe(2);
  });

  it("sends the actor header and shows the audit log", async () => {
    const entry = {
      id: "aud_1",
      at: "2026-09-28T09:00:00.000Z",
      actor: "arnav",
      action: "branch.deleted",
      targetType: "branch",
      targetId: "br_fork",
      traceId: "trc_1",
      details: { name: "limit-100", deleted: ["br_fork"] },
      requestId: "req_1",
    };
    const api = fakeApi({
      "GET /api/v1/audit": () => ({ body: { items: [entry], nextCursor: "abc" } }),
    });
    expect(
      await runWith(api, [
        "--actor",
        "arnav",
        "audit",
        "--trace",
        "trc_1",
        "--by",
        "arnav",
        "--action",
        "branch.deleted",
      ]),
    ).toBe(0);
    const call = api.captured.calls[0];
    expect(call?.headers?.["x-shadow-actor"]).toBe("arnav");
    const url = new URL(call?.url ?? "");
    expect(url.searchParams.get("traceId")).toBe("trc_1");
    expect(url.searchParams.get("actor")).toBe("arnav");
    expect(url.searchParams.get("action")).toBe("branch.deleted");
    const text = api.captured.out.join("\n");
    expect(text).toContain("branch br_fork");
    expect(text).toContain('name=limit-100 deleted=["br_fork"]');
    expect(text).toContain("more entries");

    const empty = fakeApi({
      "GET /api/v1/audit": () => ({ body: { items: [], nextCursor: null } }),
    });
    expect(await runWith(empty, ["audit"])).toBe(0);
    expect(empty.captured.out.join("\n")).toContain("no audit entries");
  });

  it("exports the audit log as CSV to stdout or a file", async () => {
    const csv =
      'at,actor,action,targetType,targetId,traceId,requestId,details\r\n2026-10-04T09:00:00.000Z,arnav,fork.created,branch,br_1,trc_1,,"{""name"":""x""}"\r\n';
    const api = fakeApi({
      "GET /api/v1/audit": () => ({ body: csv, raw: true, contentType: "text/csv" }),
    });
    expect(await runWith(api, ["audit", "--csv", "--action", "fork.created"])).toBe(0);
    expect(api.captured.calls[0]?.url).toContain("format=csv");
    expect(api.captured.calls[0]?.url).toContain("action=fork.created");
    expect(api.captured.out.join("\n")).toContain("at,actor,action,targetType");
    const dir = await mkdtemp(path.join(tmpdir(), "shadow-cli-audit-"));
    const file = path.join(dir, "audit.csv");
    expect(await runWith(api, ["audit", "--out", file])).toBe(0);
    expect(api.captured.out.at(-1)).toBe(`wrote 1 audit entry to ${file}`);
    expect(await readFile(file, "utf8")).toBe(csv);
  });

  it("exports a branch's events as CSV", async () => {
    const csv =
      "sequence,timestamp,eventType,name\r\n0,2026-09-01T09:12:04.000Z,trace.started,x\r\n";
    const api = fakeApi({
      "GET /api/v1/traces/trc_1": () => ({ body: { trace, branches: [branch] } }),
      "GET /api/v1/traces/trc_1/events": () => ({ body: csv, raw: true, contentType: "text/csv" }),
    });
    expect(
      await runWith(api, ["traces", "inspect", "trc_1", "--csv", "--type", "trace.started"]),
    ).toBe(0);
    const url = api.captured.calls[1]?.url ?? "";
    expect(url).toContain("format=csv");
    expect(url).toContain("branchId=br_main");
    expect(url).toContain("eventType=trace.started");
    expect(api.captured.out.at(-1)).toContain("sequence,timestamp,eventType,name");
    const dir = await mkdtemp(path.join(tmpdir(), "shadow-cli-events-"));
    const file = path.join(dir, "events.csv");
    expect(await runWith(api, ["traces", "inspect", "trc_1", "--out", file])).toBe(0);
    expect(api.captured.out.at(-1)).toBe(`wrote 1 event of br_main to ${file}`);
    expect(await readFile(file, "utf8")).toBe(csv);
  });

  it("runs batches in the background and follows jobs", async () => {
    const result = {
      matched: 2,
      summary: { changed: 1, unchanged: 1, skipped: 0, failed: 0 },
      results: [
        {
          traceId: "trc_a",
          startedAt: "2026-09-01T09:00:00.000Z",
          status: "ok",
          outcome: {
            base: { label: "Refund issued" },
            target: { label: "Approval" },
            changed: true,
          },
          firstDivergence: { sequence: 37, summary: "policy required approval" },
        },
        {
          traceId: "trc_b",
          startedAt: "2026-09-02T09:00:00.000Z",
          status: "ok",
          outcome: {
            base: { label: "Refund issued" },
            target: { label: "Refund issued" },
            changed: false,
          },
          firstDivergence: null,
        },
      ],
    };
    const job = (status: string, done: number, withResult = false) => ({
      id: "job_1",
      kind: "batch_counterfactual",
      status,
      request: { agent: "refund-agent", at: { eventType: "tool.request", name: "refund_order" } },
      progress: {
        total: 2,
        done,
        changed: done > 0 ? 1 : 0,
        unchanged: done > 1 ? 1 : 0,
        skipped: 0,
        failed: 0,
      },
      result: withResult ? result : null,
      error: null,
      createdAt: "2026-09-27T09:00:00.000Z",
      startedAt: null,
      finishedAt: null,
    });
    const polls = [job("queued", 0), job("running", 1), job("completed", 2, true)];
    const api = fakeApi({
      "POST /api/v1/batch/counterfactuals": () => ({ status: 202, body: job("queued", 0) }),
      "GET /api/v1/batch/jobs/job_1": () => ({ body: polls.shift() ?? job("completed", 2, true) }),
      "GET /api/v1/batch/jobs": () => ({ body: { items: [job("running", 1)] } }),
      "POST /api/v1/batch/jobs/job_1/cancel": () => ({ body: job("running", 1) }),
    });
    const args = [
      "batch",
      "--agent",
      "refund-agent",
      "--at",
      "refund_order",
      "--set",
      "refundLimit=100",
    ];

    expect(await runWith(api, [...args, "--background", "--limit", "200"])).toBe(0);
    const sent = api.captured.calls[0]?.body as { background?: boolean; limit: number };
    expect(sent).toMatchObject({ background: true, limit: 200 });
    expect(api.captured.out.join("\n")).toContain(
      "queued job_1; follow it with: shadow jobs show job_1",
    );

    api.captured.out.length = 0;
    expect(await runWith(api, [...args, "--wait", "--interval", "1"])).toBe(0);
    const waited = api.captured.out.join("\n");
    expect(waited).toContain("job_1  queued  0/2 trace(s)");
    expect(waited).toContain("job_1  running  1/2 trace(s): 1 changed");
    expect(waited).toContain("job_1  completed  2/2 trace(s)");
    expect(waited).toContain("#37 policy required approval");
    expect(waited).toContain("2 of 2 matching trace(s): 1 changed, 1 unchanged");

    api.captured.out.length = 0;
    expect(await runWith(api, ["jobs", "list"])).toBe(0);
    expect(api.captured.out.join("\n")).toMatch(
      /job_1\s+running\s+refund-agent\s+refund_order\s+1\/2/,
    );
    expect(await runWith(api, ["jobs", "show", "job_1"])).toBe(0);
    expect(await runWith(api, ["jobs", "cancel", "job_1"])).toBe(0);
    expect(api.captured.out.join("\n")).toContain("asked job_1 to stop");

    const failing = fakeApi({
      "POST /api/v1/batch/counterfactuals": () => ({ status: 202, body: job("queued", 0) }),
      "GET /api/v1/batch/jobs/job_1": () => ({
        body: { ...job("failed", 0), error: "interrupted by an API restart" },
      }),
    });
    expect(await runWith(failing, [...args, "--wait", "--interval", "1"])).toBe(1);
  });

  it("manages shared views and lists traces through one", async () => {
    const view = {
      id: "view_1",
      name: "costly failures",
      query: "sort=totalEstimatedCost&status=failed",
      description: null,
      createdAt: "2026-09-27T09:00:00.000Z",
      updatedAt: "2026-09-27T09:00:00.000Z",
    };
    const api = fakeApi({
      "GET /api/v1/views": () => ({ body: { items: [view] } }),
      "POST /api/v1/views": (body) => ({
        status: 201,
        body: { ...view, ...(body as object), query: "status=failed" },
      }),
      "DELETE /api/v1/views/view_1": () => ({ status: 204, body: null }),
      "GET /api/v1/traces": () => ({ body: { items: [trace], nextCursor: null } }),
    });

    expect(await runWith(api, ["views", "list"])).toBe(0);
    expect(api.captured.out.join("\n")).toContain("sort=totalEstimatedCost&status=failed");

    expect(
      await runWith(api, [
        "views",
        "save",
        "costly failures",
        "status=failed",
        "--description",
        "x",
      ]),
    ).toBe(0);
    const saved = api.captured.calls.find((c) => c.method === "POST");
    expect(saved?.body).toEqual({
      name: "costly failures",
      query: "status=failed",
      description: "x",
    });

    // The view supplies the filters; explicit options win over it.
    expect(
      await runWith(api, ["traces", "list", "--view", "costly failures", "--status", "completed"]),
    ).toBe(0);
    const lookup = api.captured.calls.filter((c) => c.url.includes("/api/v1/views?"));
    expect(lookup.at(-1)?.url).toContain("name=costly+failures");
    const listCall = new URL(
      api.captured.calls.filter((c) => c.url.includes("/api/v1/traces")).at(-1)?.url ?? "",
    );
    expect(listCall.searchParams.get("sort")).toBe("totalEstimatedCost");
    expect(listCall.searchParams.get("status")).toBe("completed");

    expect(await runWith(api, ["views", "delete", "costly failures"])).toBe(0);
    expect(api.captured.calls.at(-1)).toMatchObject({
      method: "DELETE",
      url: expect.stringContaining("/api/v1/views/view_1"),
    });
    expect(await runWith(api, ["views", "delete", "view_1"])).toBe(0);
  });

  it("exports a trace as OTLP and can push it to a collector", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "shadow-otlp-export-"));
    const payload = {
      resourceSpans: [
        {
          resource: {
            attributes: [{ key: "service.name", value: { stringValue: "refund-agent" } }],
          },
          scopeSpans: [
            {
              scope: { name: "@shadow/api" },
              spans: [
                {
                  traceId: "a".repeat(32),
                  spanId: "b".repeat(16),
                  name: "invoke_agent refund-agent",
                },
                {
                  traceId: "a".repeat(32),
                  spanId: "c".repeat(16),
                  name: "execute_tool refund_order",
                },
              ],
            },
          ],
        },
      ],
    };
    const api = fakeApi({
      "GET /api/v1/traces/trc_1/export": () => ({ body: payload }),
      "POST /v1/traces": () => ({ body: { partialSuccess: {} } }),
    });
    const file = path.join(dir, "trace.otlp.json");
    expect(
      await runWith(api, [
        "otlp",
        "export",
        "trc_1",
        "--out",
        file,
        "--collector",
        "http://collector.test:4318/v1/traces",
        "--header",
        "x-api-key: secret",
      ]),
    ).toBe(0);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(payload);
    const exportCall = api.captured.calls[0];
    expect(exportCall?.url).toContain("/api/v1/traces/trc_1/export?format=otlp");
    const push = api.captured.calls[1];
    expect(push?.method).toBe("POST");
    expect(push?.url).toBe("http://collector.test:4318/v1/traces");
    expect(push?.headers).toMatchObject({
      "content-type": "application/json",
      "x-api-key": "secret",
    });
    expect(push?.body).toEqual(payload);
    const text = api.captured.out.join("\n");
    expect(text).toContain("wrote 2 span(s) to");
    expect(text).toContain("sent 2 span(s) to http://collector.test:4318/v1/traces");

    // Without --out or --collector the payload goes to stdout.
    const stdout = fakeApi({ "GET /api/v1/traces/trc_1/export": () => ({ body: payload }) });
    expect(await runWith(stdout, ["otlp", "export", "trc_1"])).toBe(0);
    expect(JSON.parse(stdout.captured.out.join("\n"))).toEqual(payload);

    // protobuf needs somewhere to go; a rejecting collector fails the command
    expect(await runWith(fakeApi({}), ["otlp", "export", "trc_1", "--protobuf"])).toBe(2);
    const rejecting = fakeApi({
      "GET /api/v1/traces/trc_1/export": () => ({ body: payload }),
      "POST /v1/traces": () => ({ status: 400, body: { error: "bad" } }),
    });
    expect(
      await runWith(rejecting, [
        "otlp",
        "export",
        "trc_1",
        "--collector",
        "http://c.test/v1/traces",
      ]),
    ).toBe(1);
    expect(
      await runWith(api, ["otlp", "export", "trc_1", "--collector", "c", "--header", "x"]),
    ).toBe(2);
    expect(await runWith(fakeApi({}), ["otlp", "import", path.join(dir, "missing.json")])).toBe(2);
  });

  it("prints per-agent statistics", async () => {
    const api = fakeApi({
      "GET /api/v1/stats/agents": () => ({
        body: {
          from: null,
          to: null,
          items: [
            {
              agentId: "agt_1",
              agentSlug: "refund-agent",
              agentName: "Refund Agent",
              projectSlug: "support-agent",
              projectName: "Support",
              traces: 12,
              completed: 9,
              failed: 3,
              running: 0,
              policyViolations: 2,
              toolErrors: 1,
              avgDurationMs: 4210,
              p95DurationMs: 6100,
              totalEstimatedCost: 0.0576,
              avgEstimatedCost: 0.0048,
              totalTokens: 7476,
              lastStartedAt: "2026-09-10T08:00:00.000Z",
            },
          ],
        },
      }),
    });
    expect(await runWith(api, ["agents", "--project", "support-agent", "--from", "30d"])).toBe(0);
    const params = new URL(api.captured.calls[0]?.url ?? "").searchParams;
    expect(params.get("project")).toBe("support-agent");
    expect(params.get("from")).toMatch(/^\d{4}-/);
    const text = api.captured.out.join("\n");
    expect(text).toContain("refund-agent");
    expect(text).toContain("12");
    expect(text).toContain("4.21s");
    expect(text).toContain("6.10s");
    expect(text).toContain("7476");
    const empty = fakeApi({
      "GET /api/v1/stats/agents": () => ({ body: { from: null, to: null, items: [] } }),
    });
    expect(await runWith(empty, ["agents"])).toBe(0);
    expect(empty.captured.out.join("\n")).toContain("no traces in range");
  });

  it("prints per-model usage and points at unpriced models", async () => {
    const api = fakeApi({
      "GET /api/v1/stats/models": () => ({
        body: {
          from: null,
          to: null,
          items: [
            {
              provider: "openai",
              model: "gpt-4o",
              calls: 12,
              traces: 5,
              inputTokens: 9000,
              outputTokens: 1200,
              totalTokens: 10200,
              estimatedCost: 0.0345,
              pricedCalls: 12,
              lastUsedAt: "2026-10-28T09:00:00.000Z",
            },
            {
              provider: "local",
              model: "llama-3",
              calls: 3,
              traces: 2,
              inputTokens: 100,
              outputTokens: 50,
              totalTokens: 150,
              estimatedCost: 0,
              pricedCalls: 0,
              lastUsedAt: null,
            },
          ],
        },
      }),
    });
    expect(await runWith(api, ["models", "--agent", "refund-agent", "--from", "7d"])).toBe(0);
    const params = new URL(api.captured.calls[0]?.url ?? "").searchParams;
    expect(params.get("agent")).toBe("refund-agent");
    expect(params.get("from")).toMatch(/^20/);
    const text = api.captured.out.join("\n");
    expect(text).toMatch(/openai\s+gpt-4o\s+12\s+5\s+9000\s+1200\s+10200/);
    expect(text).toMatch(/llama-3.*0\/3/);
    expect(text).toContain("1 model(s) have calls without a cost estimate");
    const empty = fakeApi({
      "GET /api/v1/stats/models": () => ({ body: { from: null, to: null, items: [] } }),
    });
    expect(await runWith(empty, ["models"])).toBe(0);
    expect(empty.captured.out.join("\n")).toContain("no model calls in range");
  });

  it("pauses and resumes alert rules by name or id", async () => {
    const rule = {
      id: "alr_9",
      name: "slow refunds",
      agent: "refund-agent",
      project: null,
      tag: null,
      metric: "p95_duration_ms",
      mode: "threshold",
      baselineWindows: 7,
      lastBaseline: null,
      threshold: 30_000,
      windowMinutes: 60,
      minTraces: 1,
      keepFiringMinutes: 0,
      enabled: true,
      state: "firing",
      lastValue: 45_000,
      lastTraces: 4,
      lastEvaluatedAt: "2026-10-29T08:00:00.000Z",
      lastTriggeredAt: "2026-10-29T08:00:00.000Z",
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-29T08:00:00.000Z",
    };
    const api = fakeApi({
      "GET /api/v1/alerts/rules": () => ({ body: { items: [rule] } }),
      "PATCH /api/v1/alerts/rules/alr_9": (body) => ({
        body: { ...rule, ...(body as { enabled: boolean }), state: "ok" },
      }),
    });
    expect(await runWith(api, ["alerts", "pause", "slow refunds"])).toBe(0);
    expect(api.captured.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "GET /api/v1/alerts/rules",
      "PATCH /api/v1/alerts/rules/alr_9",
    ]);
    expect(api.captured.calls[1]?.body).toEqual({ enabled: false });
    expect(api.captured.out.join("\n")).toContain("paused alert rule slow refunds");
    expect(api.captured.out.join("\n")).toContain("shadow alerts resume 'slow refunds'");

    api.captured.calls.length = 0;
    api.captured.out.length = 0;
    expect(await runWith(api, ["alerts", "resume", "alr_9", "--json"])).toBe(0);
    // An id needs no lookup.
    expect(api.captured.calls).toHaveLength(1);
    expect(api.captured.calls[0]?.body).toEqual({ enabled: true });
    expect(JSON.parse(api.captured.out.join("\n"))).toMatchObject({ id: "alr_9", enabled: true });

    expect(await runWith(api, ["alerts", "pause", "no such rule"])).toBe(4);
  });

  it("prints usage per tool", async () => {
    const api = fakeApi({
      "GET /api/v1/stats/tools": () => ({
        body: {
          from: null,
          to: null,
          items: [
            {
              tool: "read_customer",
              calls: 20,
              traces: 10,
              errors: 0,
              blocked: 0,
              errorRate: 0,
              avgDurationMs: 42,
              p95DurationMs: 80,
              estimatedCost: 0,
              lastUsedAt: "2026-10-29T09:00:00.000Z",
            },
            {
              tool: "refund_order",
              calls: 8,
              traces: 8,
              errors: 2,
              blocked: 1,
              errorRate: 0.25,
              avgDurationMs: 1500,
              p95DurationMs: null,
              estimatedCost: 0,
              lastUsedAt: null,
            },
          ],
        },
      }),
    });
    expect(await runWith(api, ["tools", "--project", "demo", "--to", "2026-10-29T00:00:00Z"])).toBe(
      0,
    );
    const params = new URL(api.captured.calls[0]?.url ?? "").searchParams;
    expect(params.get("project")).toBe("demo");
    expect(params.get("to")).toBe("2026-10-29T00:00:00.000Z");
    const text = api.captured.out.join("\n");
    expect(text).toMatch(/read_customer\s+20\s+10\s+0\s+0\s+42ms\s+80ms\s+2026-10-29/);
    expect(text).toMatch(/refund_order\s+8\s+8\s+2 \(25\.0%\)\s+1\s+1\.50s\s+-\s+-/);
    expect(text).toContain("1 tool(s) had errors");
    const empty = fakeApi({
      "GET /api/v1/stats/tools": () => ({ body: { from: null, to: null, items: [] } }),
    });
    expect(await runWith(empty, ["tools"])).toBe(0);
    expect(empty.captured.out.join("\n")).toContain("no tool calls in range");
  });

  it("lists and shows saved comparisons", async () => {
    const comparison = {
      id: "cmp_1",
      traceId: "trc_1",
      targetTraceId: "trc_2",
      baseBranchId: "br_main",
      targetBranchId: "br_other",
      createdAt: "2026-09-03T10:00:00.000Z",
      result: {
        base: {
          branchId: "br_main",
          name: "main",
          metrics: trace.metrics,
          outcome: trace.outcome,
          eventCount: 52,
        },
        target: {
          branchId: "br_other",
          name: "main",
          metrics: trace.metrics,
          outcome: null,
          eventCount: 50,
        },
        steps: [],
        sharedPrefixSequence: -1,
        firstDivergence: {
          stepIndex: 3,
          sequence: 7,
          reason: "output_changed",
          summary: "refund_order returned a different result",
          base: null,
          target: null,
          fields: [{ path: "output.status", before: "processed", after: "queued" }],
        },
        addedEvents: [],
        removedEvents: [],
        modifiedEvents: [],
        toolCalls: [],
        context: { diff: [] },
        state: { diff: [] },
        metrics: Object.fromEntries(
          [
            "totalTokens",
            "inputTokens",
            "outputTokens",
            "totalEstimatedCost",
            "durationMs",
            "toolCalls",
            "modelCalls",
          ].map((k) => [k, { base: 1, target: 2, delta: 1, percent: 100 }]),
        ),
        outcome: { base: trace.outcome, target: null, changed: true },
        policy: { base: [], target: [], changed: false },
      },
    };
    const api = fakeApi({
      "GET /api/v1/comparisons": () => ({ body: { items: [comparison], nextCursor: null } }),
      "GET /api/v1/comparisons/cmp_1": () => ({ body: comparison }),
    });
    expect(await runWith(api, ["comparisons", "list", "trc_1"])).toBe(0);
    expect(new URL(api.captured.calls[0]?.url ?? "").searchParams.get("traceId")).toBe("trc_1");
    let text = api.captured.out.join("\n");
    expect(text).toContain("cmp_1");
    expect(text).toContain("main (trc_2)");
    expect(text).toContain("changed");
    expect(text).toContain("#7 refund_order returned a different result");
    expect(text).toContain("1 comparison(s)");

    api.captured.out.length = 0;
    expect(await runWith(api, ["comparisons", "show", "cmp_1"])).toBe(0);
    text = api.captured.out.join("\n");
    expect(text).toContain("main (original)  vs  main (counterfactual)");
    expect(text).toContain("first divergence at sequence 7");
    expect(text).toContain('output.status: "processed" -> "queued"');
    expect(text).toContain("comparison id cmp_1");

    const none = fakeApi({
      "GET /api/v1/comparisons": () => ({ body: { items: [], nextCursor: null } }),
    });
    expect(await runWith(none, ["comparisons", "list", "trc_1"])).toBe(0);
    expect(none.captured.out.join("\n")).toContain("no comparisons found");
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

  it("runs batch counterfactuals across an agent's traces", async () => {
    const api = fakeApi({
      "POST /api/v1/batch/counterfactuals": () => ({
        status: 201,
        body: {
          agent: "refund-agent",
          matched: 5,
          summary: { changed: 1, unchanged: 1, skipped: 1, failed: 0 },
          results: [
            {
              traceId: "trc_a",
              startedAt: "2026-09-02T09:00:00.000Z",
              status: "ok",
              outcome: {
                base: { label: "Policy violation" },
                target: { label: "Approval requested" },
                changed: true,
              },
              firstDivergence: { sequence: 36, summary: "policy denied the refund" },
              comparisonId: "cmp_a",
            },
            {
              traceId: "trc_b",
              startedAt: "2026-09-01T09:00:00.000Z",
              status: "ok",
              outcome: {
                base: { label: "Refund issued" },
                target: { label: "Refund issued" },
                changed: false,
              },
              firstDivergence: null,
              comparisonId: "cmp_b",
            },
            {
              traceId: "trc_c",
              startedAt: "2026-08-31T09:00:00.000Z",
              status: "skipped",
              reason: "no tool.request 'refund_order' event on the root branch",
            },
          ],
        },
      }),
    });
    expect(
      await runWith(api, [
        "batch",
        "--agent",
        "refund-agent",
        "--at",
        "refund_order",
        "--set",
        "refundLimit=100",
        "--from",
        "2026-08-01",
        "--limit",
        "3",
      ]),
    ).toBe(0);
    expect(api.captured.calls[0]?.body).toEqual({
      agent: "refund-agent",
      at: { eventType: "tool.request", name: "refund_order" },
      overrides: [{ kind: "context", op: "set", key: "refundLimit", value: 100 }],
      from: "2026-08-01T00:00:00.000Z",
      limit: 3,
    });
    const text = api.captured.out.join("\n");
    expect(text).toContain("Approval requested");
    expect(text).toContain("identical");
    expect(text).toContain("skipped");
    expect(text).toContain("3 of 5 matching trace(s): 1 changed, 1 unchanged, 1 skipped, 0 failed");

    const typed = fakeApi({
      "POST /api/v1/batch/counterfactuals": () => ({
        status: 201,
        body: {
          matched: 0,
          summary: { changed: 0, unchanged: 0, skipped: 0, failed: 0 },
          results: [],
        },
      }),
    });
    expect(
      await runWith(typed, [
        "batch",
        "--agent",
        "a",
        "--at",
        "policy.evaluated:refund.limit",
        "--policy",
        'refund.limit={"max":50}',
      ]),
    ).toBe(0);
    expect((typed.captured.calls[0]?.body as { at: unknown }).at).toEqual({
      eventType: "policy.evaluated",
      name: "refund.limit",
    });
    expect(typed.captured.out.join("\n")).toContain("no traces matched");
    expect(await runWith(fakeApi({}), ["batch", "--agent", "a", "--at", "x"])).toBe(2);
    expect(
      await runWith(api, [
        "batch",
        "--agent",
        "refund-agent",
        "--at",
        "refund_order",
        "--set",
        "refundLimit=100",
        "--max-events",
        "300",
        "--max-cost",
        "0.5",
      ]),
    ).toBe(0);
    expect((api.captured.calls.at(-1)?.body as { budget: unknown }).budget).toEqual({
      maxEvents: 300,
      maxCostUsd: 0.5,
    });
  });

  it("runs a scenario matrix from --vary grids", async () => {
    const api = fakeApi({
      "POST /api/v1/traces/trc_1/forks/matrix": (body) => ({
        status: 201,
        body: {
          variants: (body as { variants: { name: string }[] }).variants.map((v, i) => ({
            name: v.name,
            branch: { ...branch, id: `br_m${i}`, name: v.name },
            replay: { status: "completed" },
            comparisonId: `cmp_m${i}`,
            outcome: {
              target: { label: i === 0 ? "Approval requested" : "Refund issued" },
              changed: i === 0,
            },
            firstDivergence: i === 0 ? { sequence: 37, summary: "policy denied the refund" } : null,
            deltas: { totalEstimatedCost: i === 0 ? -0.002 : 0, durationMs: 0 },
          })),
        },
      }),
    });
    expect(
      await runWith(api, [
        "matrix",
        "trc_1",
        "--at",
        "evt_7",
        "--vary",
        "refundLimit=100,500",
        "--vary",
        "tier=gold",
      ]),
    ).toBe(0);
    const sent = api.captured.calls[0]?.body as {
      forkEventId: string;
      variants: { name: string; overrides: unknown[] }[];
    };
    expect(sent.forkEventId).toBe("evt_7");
    expect(sent.variants).toEqual([
      {
        name: 'refundLimit=100 tier="gold"',
        overrides: [
          { kind: "context", op: "set", key: "refundLimit", value: 100 },
          { kind: "context", op: "set", key: "tier", value: "gold" },
        ],
      },
      {
        name: 'refundLimit=500 tier="gold"',
        overrides: [
          { kind: "context", op: "set", key: "refundLimit", value: 500 },
          { kind: "context", op: "set", key: "tier", value: "gold" },
        ],
      },
    ]);
    const text = api.captured.out.join("\n");
    expect(text).toContain("Approval requested");
    expect(text).toContain("#37 policy denied the refund");
    expect(text).toContain("identical");
    expect(text).toContain("2 variant(s), 1 changed the outcome");

    const values = Array.from({ length: 21 }, (_, i) => i).join(",");
    expect(
      await runWith(fakeApi({}), ["matrix", "trc_1", "--at", "evt_7", "--vary", `n=${values}`]),
    ).toBe(2);
    expect(
      await runWith(fakeApi({}), ["matrix", "trc_1", "--at", "evt_7", "--vary", "broken"]),
    ).toBe(2);
    expect(
      await runWith(api, [
        "matrix",
        "trc_1",
        "--at",
        "evt_fork",
        "--vary",
        "refundLimit=100",
        "--max-duration",
        "90000",
      ]),
    ).toBe(0);
    expect((api.captured.calls.at(-1)?.body as { budget: unknown }).budget).toEqual({
      maxDurationMs: 90000,
    });
  });

  it("builds matrix axes over tool results and policy configurations", async () => {
    const api = fakeApi({
      "POST /api/v1/traces/trc_1/forks/matrix": (body) => ({
        status: 201,
        body: {
          variants: (body as { variants: { name: string }[] }).variants.map((v, i) => ({
            name: v.name,
            branch: { ...branch, id: `br_m${i}`, name: v.name },
            replay: { status: "completed" },
            comparisonId: `cmp_m${i}`,
            outcome: { target: { label: "Refund issued" }, changed: false },
            firstDivergence: null,
            deltas: { totalEstimatedCost: 0, durationMs: 0 },
          })),
        },
      }),
    });
    expect(
      await runWith(api, [
        "matrix",
        "trc_1",
        "--at",
        "evt_7",
        "--vary-tool",
        'refund_order={"status":"failed","code":"card_declined"}',
        "--vary-tool",
        'refund_order={"status":"processed"}',
        "--vary-policy",
        'refund.autonomous_limit={"limit":100}',
        "--json",
      ]),
    ).toBe(0);
    const sent = api.captured.calls[0]?.body as {
      variants: { name: string; overrides: unknown[] }[];
    };
    expect(sent.variants).toEqual([
      {
        name: 'refund_order={"status":"failed","code":"card_declined"} refund.autonomous_limit={"limit":100}',
        overrides: [
          {
            kind: "tool_result",
            tool: "refund_order",
            occurrence: 1,
            result: { status: "failed", code: "card_declined" },
          },
          { kind: "policy", policy: "refund.autonomous_limit", config: { limit: 100 } },
        ],
      },
      {
        name: 'refund_order={"status":"processed"} refund.autonomous_limit={"limit":100}',
        overrides: [
          {
            kind: "tool_result",
            tool: "refund_order",
            occurrence: 1,
            result: { status: "processed" },
          },
          { kind: "policy", policy: "refund.autonomous_limit", config: { limit: 100 } },
        ],
      },
    ]);
    expect(JSON.parse(api.captured.out.join("\n")) as unknown).toHaveProperty("variants");

    // policy configurations must be objects; the matrix needs at least one axis
    expect(
      await runWith(fakeApi({}), [
        "matrix",
        "trc_1",
        "--at",
        "evt_7",
        "--vary-policy",
        "refund.autonomous_limit=100",
      ]),
    ).toBe(2);
    expect(await runWith(fakeApi({}), ["matrix", "trc_1", "--at", "evt_7"])).toBe(2);
    expect(
      await runWith(fakeApi({}), ["matrix", "trc_1", "--at", "evt_7", "--vary-tool", "nope"]),
    ).toBe(2);
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
    expect(api.captured.calls.at(-1)?.body).toEqual({ mode: "deterministic" });
    expect(
      await runWith(api, [
        "replay",
        "br_fork",
        "--max-events",
        "50",
        "--max-cost",
        "1.5",
        "--max-duration",
        "60000",
      ]),
    ).toBe(0);
    expect(api.captured.calls.at(-1)?.body).toEqual({
      mode: "deterministic",
      budget: { maxEvents: 50, maxCostUsd: 1.5, maxDurationMs: 60000 },
    });
    expect(await runWith(api, ["compare", "br_main", "br_fork"])).toBe(0);
    const text = api.captured.out.join("\n");
    expect(text).toContain("first divergence at sequence 36");
    expect(text).toContain("Approval requested");
    expect(text).toContain("-41.0%");
  });
});
