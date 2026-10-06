import type { JsonValue, PolicyCall } from "@shadow/schemas";
import { toJson } from "./pointer.js";
import { ToolError, type Trace } from "./trace.js";

/**
 * Recording for agents that use Model Context Protocol servers through an MCP client.
 *
 * `traceMcpClient(trace, client)` returns the same client with `callTool` recorded as a tool
 * span, `readResource` as a span named after the resource, and the catalogue calls
 * (`listTools`, `listResources`, `listPrompts`, `getPrompt`) and `connect` as notes and context.
 * Everything else passes through. The client is matched structurally, so there is no
 * dependency on `@modelcontextprotocol/sdk` and the caller keeps its own types.
 */

type Fn = (...args: unknown[]) => unknown;

/** The part of a `tools/call` result this adapter reads. */
export interface McpToolResultLike {
  content?: unknown;
  structuredContent?: unknown;
  isError?: boolean;
}

export interface TraceMcpOptions {
  /** Server name, recorded on every event and used to qualify tool names. */
  server?: string;
  /** Record tools as `<server>/<tool>` (default) or by their bare name. */
  qualifyToolNames?: boolean;
  /** Policy to evaluate inside a tool's span before the call reaches the server. */
  guard?: (tool: string, args: JsonValue) => PolicyCall | undefined;
  /** Character cap for resource contents kept in the trace (default 64 KiB); larger ones are summarised. */
  resourceContentLimit?: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

/** Text of an MCP result's content blocks, for error messages and notes. */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is Record<string, unknown> => isObject(b) && b.type === "text")
    .map((b) => String(b.text ?? ""))
    .filter((t) => t.length > 0)
    .join("\n");
}

/** Keep resource contents within the cap; summarise what is cut. */
function capContents(contents: unknown, limit: number): JsonValue {
  if (!Array.isArray(contents)) return toJson(contents ?? null);
  return contents.map((item) => {
    if (!isObject(item)) return toJson(item);
    const out: Record<string, unknown> = { ...item };
    for (const key of ["text", "blob"]) {
      const value = out[key];
      if (typeof value === "string" && value.length > limit) {
        out[key] = `${value.slice(0, limit)}…`;
        out[`${key}Length`] = value.length;
        out.truncated = true;
      }
    }
    return toJson(out);
  });
}

/**
 * Wrap an MCP client so its requests are recorded on `trace`. `callTool` becomes a tool span
 * (`tool.error` when the server answers `isError` or the transport fails, with the result still
 * returned to the caller as the client would), `readResource` becomes a span named
 * `resource:<uri>`, and `connect`, `listTools`, `listResources`, `listPrompts` and `getPrompt`
 * become `mcp.*` notes; the tool catalogue is also kept as context so a fork can change it.
 */
export function traceMcpClient<C extends object>(
  trace: Trace,
  client: C,
  options: TraceMcpOptions = {},
): C {
  const server = options.server;
  const mcp = (extra: Record<string, JsonValue> = {}) => ({
    mcp: { ...(server ? { server } : {}), ...extra },
  });
  const qualify = (tool: string) =>
    options.qualifyToolNames !== false && server ? `${server}/${tool}` : tool;
  const limit = options.resourceContentLimit ?? 64 * 1024;

  return new Proxy(client, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== "function") return value;
      const original = (value as Fn).bind(target);

      if (prop === "callTool") {
        return async (params: { name: string; arguments?: unknown }, ...rest: unknown[]) => {
          const args = toJson(params.arguments ?? {});
          let result: McpToolResultLike | undefined;
          try {
            await trace.tool({
              name: qualify(params.name),
              arguments: args,
              metadata: mcp({ tool: params.name }),
              guard: options.guard?.(params.name, args),
              execute: async () => {
                result = (await original(params, ...rest)) as McpToolResultLike;
                if (result?.isError) {
                  throw new ToolError(textOf(result.content) || `tool ${params.name} failed`, {
                    code: "mcp_tool_error",
                  });
                }
                return {
                  result: toJson({
                    content: result?.content ?? null,
                    ...(result?.structuredContent !== undefined
                      ? { structuredContent: result.structuredContent }
                      : {}),
                  }),
                };
              },
            });
          } catch (error) {
            // The server's own error result goes back to the caller unchanged; transport and
            // policy failures propagate like they would without the wrapper.
            if (result?.isError && error instanceof ToolError && error.code === "mcp_tool_error") {
              return result;
            }
            throw error;
          }
          return result;
        };
      }

      if (prop === "readResource") {
        return async (params: { uri: string }, ...rest: unknown[]) => {
          let response: unknown;
          await trace.tool({
            name: `resource:${params.uri}`,
            arguments: { uri: params.uri },
            metadata: mcp({ kind: "resource" }),
            execute: async () => {
              response = await original(params, ...rest);
              const contents = isObject(response) ? response.contents : undefined;
              return { result: { contents: capContents(contents, limit) } };
            },
          });
          return response;
        };
      }

      if (prop === "connect") {
        return async (...args: unknown[]) => {
          const response = await original(...args);
          const info = (name: string) => {
            const fn = Reflect.get(target, name, target) as unknown;
            return typeof fn === "function" ? toJson((fn as Fn).call(target) ?? null) : null;
          };
          trace.note("mcp.session_started", {
            ...(server ? { server } : {}),
            serverInfo: info("getServerVersion"),
            capabilities: info("getServerCapabilities"),
          });
          return response;
        };
      }

      if (prop === "listTools") {
        return async (...args: unknown[]) => {
          const response = await original(...args);
          const tools = isObject(response) && Array.isArray(response.tools) ? response.tools : [];
          const names = tools
            .map((t) => (isObject(t) && typeof t.name === "string" ? t.name : null))
            .filter((n): n is string => n !== null);
          trace.note("mcp.tools_listed", { ...(server ? { server } : {}), tools: toJson(tools) });
          trace.context.set(server ? `mcp.tools:${server}` : "mcp.tools", names);
          return response;
        };
      }

      if (prop === "listResources" || prop === "listPrompts") {
        return async (...args: unknown[]) => {
          const response = await original(...args);
          trace.note(prop === "listResources" ? "mcp.resources_listed" : "mcp.prompts_listed", {
            ...(server ? { server } : {}),
            result: toJson(response ?? null),
          });
          return response;
        };
      }

      if (prop === "getPrompt") {
        return async (params: { name: string; arguments?: unknown }, ...rest: unknown[]) => {
          const response = await original(params, ...rest);
          trace.note("mcp.prompt_retrieved", {
            ...(server ? { server } : {}),
            prompt: params.name,
            arguments: toJson(params.arguments ?? null),
            result: toJson(response ?? null),
          });
          return response;
        };
      }

      return original;
    },
  });
}
