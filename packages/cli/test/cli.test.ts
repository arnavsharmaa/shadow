import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CLI_VERSION, run } from "../src/index.js";

interface Captured {
  out: string[];
  err: string[];
  calls: { method: string; url: string; body?: unknown }[];
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
    captured.calls.push({ method, url, body });
    const parsed = new URL(url);
    const key = `${method} ${parsed.pathname}`;
    const handler = routes[key];
    if (!handler)
      return new Response(
        JSON.stringify({ error: { code: "not_found", message: `no route ${key}` } }),
        { status: 404 },
      );
    const result = handler(body);
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
