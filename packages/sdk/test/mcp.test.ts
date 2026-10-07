import { describe, expect, it } from "vitest";
import { MemoryTransport, Shadow, traceMcpClient, type IngestEventInput } from "../src/index.js";

class FakeMcpClient {
  #connected = false;
  readonly calls: { name: string; arguments?: unknown }[] = [];
  readonly reads: string[] = [];
  constructor(private readonly results: Record<string, unknown>) {}
  async connect(_transport: unknown): Promise<void> {
    this.#connected = true;
  }
  getServerVersion() {
    return this.#connected ? { name: "github", version: "2.1.0" } : undefined;
  }
  getServerCapabilities() {
    return { tools: {}, resources: { subscribe: true } };
  }
  async listTools() {
    return {
      tools: [
        { name: "search_issues", inputSchema: { type: "object" } },
        { name: "create_issue", inputSchema: { type: "object" } },
      ],
    };
  }
  async listResources() {
    return { resources: [{ uri: "repo://acme/readme", name: "README" }] };
  }
  async getPrompt(params: { name: string; arguments?: unknown }) {
    return {
      messages: [{ role: "user", content: { type: "text", text: `prompt ${params.name}` } }],
    };
  }
  async callTool(params: { name: string; arguments?: unknown }) {
    this.calls.push(params);
    const result = this.results[params.name];
    if (result instanceof Error) throw result;
    return result;
  }
  async readResource(params: { uri: string }) {
    this.reads.push(params.uri);
    return {
      contents: [
        { uri: params.uri, mimeType: "text/plain", text: "x".repeat(100) },
        { uri: `${params.uri}.bin`, mimeType: "application/octet-stream", blob: "AAAA" },
      ],
    };
  }
  ping() {
    return "pong";
  }

  // Handlers the host registers for requests and notifications the server sends.
  readonly #requestHandlers = new Map<unknown, (message: unknown, extra: unknown) => unknown>();
  readonly #notificationHandlers = new Map<unknown, (message: unknown) => unknown>();
  readonly #schemas = new Map<string, unknown>();
  setRequestHandler(schema: unknown, handler: (message: unknown, extra: unknown) => unknown) {
    this.#requestHandlers.set(schema, handler);
    this.#remember(schema);
  }
  setNotificationHandler(schema: unknown, handler: (message: unknown) => unknown) {
    this.#notificationHandlers.set(schema, handler);
    this.#remember(schema);
  }
  #remember(schema: unknown) {
    const s = schema as { shape?: unknown };
    const shape = typeof s.shape === "function" ? (s.shape as () => unknown)() : s.shape;
    const method = (shape as { method?: { value?: string; _def?: { value?: string } } } | undefined)
      ?.method;
    const name = method?.value ?? method?._def?.value;
    if (typeof name === "string") this.#schemas.set(name, schema);
  }
  /** Simulate the server sending a request; `method` may also be the raw schema object. */
  request(method: string | object, params: unknown) {
    const schema = typeof method === "string" ? this.#schemas.get(method) : method;
    const handler = this.#requestHandlers.get(schema);
    if (!handler) throw new Error(`no handler for ${String(method)}`);
    return handler({ method, params }, { requestId: 1 });
  }
  notify(method: string, params: unknown) {
    const handler = this.#notificationHandlers.get(this.#schemas.get(method));
    if (!handler) throw new Error(`no handler for ${method}`);
    return handler({ method, params });
  }
}

function setup() {
  const transport = new MemoryTransport();
  const trace = new Shadow({
    project: "ops",
    agent: "runbook",
    transport,
    flushIntervalMs: 0,
  }).startTrace({ name: "incident" });
  const events = async (): Promise<IngestEventInput[]> => {
    await trace.flush();
    return transport.eventsFor(trace.traceId);
  };
  return { trace, events };
}

const named = (list: IngestEventInput[], type: string) => list.filter((e) => e.eventType === type);

describe("traceMcpClient", () => {
  it("records tool calls, errors, resources and catalogue calls", async () => {
    const { trace, events } = setup();
    const raw = new FakeMcpClient({
      search_issues: {
        content: [{ type: "text", text: "3 issues" }],
        structuredContent: { total: 3 },
      },
      create_issue: { content: [{ type: "text", text: "rate limited" }], isError: true },
      explode: new Error("transport closed"),
    });
    const client = traceMcpClient(trace, raw, { server: "github" });
    expect(client.ping()).toBe("pong");
    await client.connect({});
    await client.listTools();
    await client.listResources();
    await client.getPrompt({ name: "triage", arguments: { repo: "acme" } });

    const ok = await client.callTool({ name: "search_issues", arguments: { q: "bug" } });
    expect(ok).toEqual({
      content: [{ type: "text", text: "3 issues" }],
      structuredContent: { total: 3 },
    });
    // A server-side error result is recorded as a failure but still handed back, as the client would.
    const failed = await client.callTool({ name: "create_issue", arguments: { title: "x" } });
    expect(failed).toMatchObject({ isError: true });
    await expect(client.callTool({ name: "explode" })).rejects.toThrow("transport closed");
    const resource = await client.readResource({ uri: "repo://acme/readme" });
    expect(resource).toMatchObject({ contents: [{ uri: "repo://acme/readme" }, {}] });
    expect(raw.calls).toHaveLength(3);

    const list = await events();
    expect(named(list, "agent.note").map((e) => e.name)).toEqual([
      "mcp.session_started",
      "mcp.tools_listed",
      "mcp.resources_listed",
      "mcp.prompt_retrieved",
    ]);
    expect(named(list, "agent.note")[0]?.output).toEqual({
      server: "github",
      serverInfo: { name: "github", version: "2.1.0" },
      capabilities: { tools: {}, resources: { subscribe: true } },
    });
    expect(
      named(list, "context.added").map((e) => [e.name, (e.output as { value: unknown }).value]),
    ).toEqual([["mcp.tools:github", ["search_issues", "create_issue"]]]);

    const requests = named(list, "tool.request");
    expect(requests.map((e) => e.name)).toEqual([
      "github/search_issues",
      "github/create_issue",
      "github/explode",
      "resource:repo://acme/readme",
    ]);
    expect(requests[0]).toMatchObject({
      input: { tool: "github/search_issues", arguments: { q: "bug" } },
      metadata: { mcp: { server: "github", tool: "search_issues" } },
    });
    expect(named(list, "tool.response").map((e) => e.name)).toEqual([
      "github/search_issues",
      "resource:repo://acme/readme",
    ]);
    expect(named(list, "tool.response")[0]?.output).toEqual({
      result: { content: [{ type: "text", text: "3 issues" }], structuredContent: { total: 3 } },
    });
    const errors = named(list, "tool.error");
    expect(
      errors.map((e) => [
        e.name,
        (e.output as { error: { message: string; code?: string } }).error,
      ]),
    ).toEqual([
      ["github/create_issue", { message: "rate limited", code: "mcp_tool_error" }],
      ["github/explode", { message: "transport closed" }],
    ]);
  });

  it("uses bare tool names on request, caps resource contents and evaluates guards", async () => {
    const { trace, events } = setup();
    const raw = new FakeMcpClient({ delete_repo: { content: [] } });
    const client = traceMcpClient(trace, raw, {
      qualifyToolNames: false,
      resourceContentLimit: 10,
      guard: (tool) =>
        tool === "delete_repo"
          ? { policy: "ops.destructive", subject: { tool }, evaluate: () => ({ decision: "deny" }) }
          : undefined,
    });
    await expect(client.callTool({ name: "delete_repo", arguments: {} })).rejects.toThrow(
      /blocked/,
    );
    expect(raw.calls).toHaveLength(0);
    await client.readResource({ uri: "repo://big" });
    const list = await events();
    expect(named(list, "tool.request")[0]?.name).toBe("delete_repo");
    expect(named(list, "policy.evaluated")).toHaveLength(1);
    const read = named(list, "tool.response").find((e) => e.name === "resource:repo://big");
    expect(read?.output).toEqual({
      result: {
        contents: [
          {
            uri: "repo://big",
            mimeType: "text/plain",
            text: "xxxxxxxxxx…",
            textLength: 100,
            truncated: true,
          },
          { uri: "repo://big.bin", mimeType: "application/octet-stream", blob: "AAAA" },
        ],
      },
    });
    expect(named(list, "context.added")).toHaveLength(0);
  });
  it("records server-initiated requests and notifications through the host's handlers", async () => {
    const { trace, events } = setup();
    const raw = new FakeMcpClient({});
    const client = traceMcpClient(trace, raw, { server: "github" });
    // Zod 3 exposes the literal through `_def`, Zod 4 through `value`; both shapes are matched.
    const schema = (method: string, legacy = false) => ({
      shape: legacy
        ? () => ({ method: { _def: { value: method } } })
        : { method: { value: method } },
    });
    client.setRequestHandler(schema("sampling/createMessage"), async (request: unknown) => {
      const { params } = request as { params: { maxTokens: number } };
      return {
        role: "assistant",
        model: "claude-sonnet-5-5",
        stopReason: "endTurn",
        content: { type: "text", text: `summary within ${params.maxTokens}` },
      };
    });
    client.setRequestHandler(schema("elicitation/create", true), async () => ({
      action: "accept",
      content: { confirm: true },
    }));
    client.setRequestHandler(schema("roots/list"), async () => ({
      roots: [{ uri: "file:///repo", name: "repo" }],
    }));
    client.setRequestHandler(schema("ping"), async () => ({}));
    const opaque = { not: "a schema" };
    client.setRequestHandler(opaque, async () => ({ untouched: true }));
    const seen: string[] = [];
    for (const method of [
      "notifications/progress",
      "notifications/message",
      "notifications/tools/list_changed",
      "notifications/resources/updated",
      "notifications/custom",
    ]) {
      client.setNotificationHandler(schema(method), (notification: unknown) => {
        seen.push((notification as { method: string }).method);
      });
    }

    const sampled = await raw.request("sampling/createMessage", {
      messages: [{ role: "user", content: { type: "text", text: "summarise issue 12" } }],
      systemPrompt: "Be brief.",
      maxTokens: 200,
      modelPreferences: { hints: [{ name: "claude-sonnet-5-5" }], intelligencePriority: 0.5 },
    });
    expect(sampled).toMatchObject({ role: "assistant", stopReason: "endTurn" });
    const elicited = await raw.request("elicitation/create", {
      message: "Delete the branch?",
      requestedSchema: { type: "object", properties: { confirm: { type: "boolean" } } },
    });
    expect(elicited).toEqual({ action: "accept", content: { confirm: true } });
    await raw.request("roots/list", {});
    await raw.request("ping", {});
    expect(await raw.request(opaque, {})).toEqual({ untouched: true });
    raw.notify("notifications/progress", { progressToken: "job-7", progress: 3, total: 10 });
    raw.notify("notifications/message", { level: "warning", logger: "sync", data: "slow" });
    raw.notify("notifications/tools/list_changed", {});
    raw.notify("notifications/resources/updated", { uri: "repo://acme/readme" });
    raw.notify("notifications/custom", { x: 1 });
    expect(seen).toHaveLength(5);

    const list = await events();
    const modelRequest = named(list, "model.request")[0];
    expect(modelRequest).toMatchObject({
      name: "sampling:github",
      input: {
        provider: "mcp",
        model: "claude-sonnet-5-5",
        messages: [
          { role: "system", content: "Be brief." },
          { role: "user", content: { type: "text", text: "summarise issue 12" } },
        ],
        parameters: {
          maxTokens: 200,
          modelPreferences: { hints: [{ name: "claude-sonnet-5-5" }], intelligencePriority: 0.5 },
        },
      },
      metadata: {
        mcp: { server: "github", initiatedBy: "server", method: "sampling/createMessage" },
      },
    });
    expect(named(list, "model.response")[0]?.output).toEqual({
      message: { role: "assistant", content: { type: "text", text: "summary within 200" } },
      finishReason: "endTurn",
    });

    const requested = named(list, "human.approval_requested")[0];
    expect(requested?.input).toEqual({
      reason: "Delete the branch?",
      request: {
        server: "github",
        requestedSchema: { type: "object", properties: { confirm: { type: "boolean" } } },
      },
    });
    const approvalId = (requested?.output as { approvalId: string }).approvalId;
    expect(named(list, "human.approval_resolved")[0]?.output).toEqual({
      approvalId,
      decision: "approved",
    });
    expect(
      named(list, "state.patch").some(
        (e) =>
          JSON.stringify(e.output).includes(`/elicitations/${approvalId}`) &&
          JSON.stringify(e.output).includes('"confirm":true'),
      ),
    ).toBe(true);
    expect(
      named(list, "context.added").map((e) => [e.name, (e.output as { value: unknown }).value]),
    ).toEqual([["mcp.roots", [{ uri: "file:///repo", name: "repo" }]]]);

    const notes = named(list, "agent.note").map((e) => [e.name, e.severity, e.output]);
    expect(notes).toEqual([
      ["mcp.server_request", "debug", { server: "github", method: "ping", params: {}, result: {} }],
      ["progress:job-7", "debug", { server: "github", progress: 3, total: 10, message: null }],
      ["mcp.log", "warn", { server: "github", level: "warning", logger: "sync", data: "slow" }],
      ["mcp.catalog_changed", "debug", { server: "github", catalog: "tools" }],
      ["mcp.resource_updated", "debug", { server: "github", uri: "repo://acme/readme" }],
      [
        "mcp.notification",
        "debug",
        { server: "github", method: "notifications/custom", params: { x: 1 } },
      ],
    ]);
  });
});
