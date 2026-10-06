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
});
