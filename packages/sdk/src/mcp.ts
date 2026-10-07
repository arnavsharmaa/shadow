import type { JsonObject, JsonValue, ModelMessage, PolicyCall, Severity } from "@shadow/schemas";
import { toJson } from "./pointer.js";
import { ToolError, type Trace } from "./trace.js";

/**
 * Recording for agents that use Model Context Protocol servers through an MCP client.
 *
 * `traceMcpClient(trace, client)` returns the same client with `callTool` recorded as a tool
 * span, `readResource` as a span named after the resource, and the catalogue calls
 * (`listTools`, `listResources`, `listPrompts`, `getPrompt`) and `connect` as notes and context.
 * Handlers registered with `setRequestHandler` and `setNotificationHandler` are wrapped so what
 * the server initiates is recorded too: sampling as a model span, elicitation as an approval,
 * roots as context, and progress, log and list-changed notifications as notes. Everything else
 * passes through. The client is matched structurally, so there is no dependency on
 * `@modelcontextprotocol/sdk` and the caller keeps its own types.
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

// ---- server-initiated requests and notifications --------------------------------------------

/** The `method` literal of an MCP request or notification schema, matched structurally. */
function methodOf(schema: unknown): string | null {
  if (!isObject(schema)) return null;
  const shape = typeof schema.shape === "function" ? (schema.shape as Fn)() : schema.shape;
  const method = isObject(shape) ? shape.method : undefined;
  if (!isObject(method)) return null;
  if (typeof method.value === "string") return method.value;
  const def = method._def;
  return isObject(def) && typeof def.value === "string" ? def.value : null;
}

/** MCP log levels (RFC 5424 names) onto Shadow severities. */
function severityOf(level: unknown): Severity {
  switch (level) {
    case "debug":
      return "debug";
    case "warning":
      return "warn";
    case "error":
    case "critical":
    case "alert":
    case "emergency":
      return "error";
    default:
      return "info";
  }
}

/** A sampling request's messages as model messages; MCP roles are `user` or `assistant`. */
function samplingMessages(params: Record<string, unknown>): ModelMessage[] {
  const messages = Array.isArray(params.messages) ? params.messages : [];
  const out: ModelMessage[] = messages.map((m) => {
    const message = isObject(m) ? m : {};
    return {
      role: message.role === "assistant" ? "assistant" : "user",
      content: toJson(message.content ?? null),
    };
  });
  if (typeof params.systemPrompt === "string") {
    out.unshift({ role: "system", content: params.systemPrompt });
  }
  return out;
}

const CATALOG_NOTIFICATIONS: Record<string, string> = {
  "notifications/tools/list_changed": "tools",
  "notifications/resources/list_changed": "resources",
  "notifications/prompts/list_changed": "prompts",
};

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
  const base: JsonObject = server ? { server } : {};
  const paramsOf = (message: unknown): Record<string, unknown> =>
    isObject(message) && isObject(message.params) ? message.params : {};

  /** The handler the host registers for a server request, recorded by request method. */
  const recordRequestHandler = (method: string, handler: Fn): Fn => {
    if (method === "sampling/createMessage") {
      return async (request: unknown, ...rest: unknown[]) => {
        const params = paramsOf(request);
        const preferences = isObject(params.modelPreferences) ? params.modelPreferences : {};
        const hint = Array.isArray(preferences.hints)
          ? preferences.hints.find(isObject)
          : undefined;
        const parameters: JsonObject = {};
        for (const [key, value] of Object.entries(params)) {
          if (key !== "messages" && key !== "systemPrompt") parameters[key] = toJson(value);
        }
        let response: unknown;
        await trace.model({
          name: server ? `sampling:${server}` : "sampling",
          provider: "mcp",
          model: typeof hint?.name === "string" ? hint.name : "host",
          messages: samplingMessages(params),
          parameters,
          metadata: mcp({ initiatedBy: "server", method }),
          execute: async () => {
            response = await handler(request, ...rest);
            const result = isObject(response) ? response : {};
            return {
              message: {
                role: result.role === "user" ? "user" : "assistant",
                content: toJson(result.content ?? null),
              },
              ...(typeof result.stopReason === "string" ? { finishReason: result.stopReason } : {}),
            };
          },
        });
        return response;
      };
    }
    if (method === "elicitation/create") {
      return async (request: unknown, ...rest: unknown[]) => {
        const params = paramsOf(request);
        const { approvalId } = await trace.requestApproval({
          reason: typeof params.message === "string" ? params.message : "elicitation",
          request: toJson({ ...base, requestedSchema: params.requestedSchema ?? null }),
        });
        const response = await handler(request, ...rest);
        const result = isObject(response) ? response : {};
        trace.resolveApproval(approvalId, result.action === "accept" ? "approved" : "rejected");
        trace.state.set(
          `/elicitations/${approvalId}`,
          toJson({ action: result.action ?? null, content: result.content ?? null }),
        );
        return response;
      };
    }
    if (method === "roots/list") {
      return async (request: unknown, ...rest: unknown[]) => {
        const response = await handler(request, ...rest);
        const roots = isObject(response) && Array.isArray(response.roots) ? response.roots : [];
        trace.context.set("mcp.roots", toJson(roots));
        return response;
      };
    }
    return async (request: unknown, ...rest: unknown[]) => {
      const response = await handler(request, ...rest);
      trace.note("mcp.server_request", {
        ...base,
        method,
        params: toJson(paramsOf(request)),
        result: toJson(response ?? null),
      });
      return response;
    };
  };

  /** A notification from the server, recorded before the host's own handler sees it. */
  const recordNotification = (method: string, notification: unknown): void => {
    const params = paramsOf(notification);
    if (method === "notifications/progress") {
      // The token names the note; repeating it in the data would only get it redacted.
      trace.note(
        `progress:${String(params.progressToken ?? "")}`,
        toJson({
          ...base,
          progress: params.progress ?? null,
          total: params.total ?? null,
          message: params.message ?? null,
        }),
      );
      return;
    }
    if (method === "notifications/message") {
      trace.note(
        "mcp.log",
        toJson({
          ...base,
          level: params.level ?? null,
          logger: params.logger ?? null,
          data: params.data ?? null,
        }),
        { severity: severityOf(params.level) },
      );
      return;
    }
    const catalog = CATALOG_NOTIFICATIONS[method];
    if (catalog) {
      trace.note("mcp.catalog_changed", { ...base, catalog });
      return;
    }
    if (method === "notifications/resources/updated") {
      trace.note("mcp.resource_updated", { ...base, uri: String(params.uri ?? "") });
      return;
    }
    trace.note("mcp.notification", { ...base, method, params: toJson(params) });
  };

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

      if (prop === "setRequestHandler") {
        return (schema: unknown, handler: Fn, ...rest: unknown[]) => {
          const method = methodOf(schema);
          return original(
            schema,
            method ? recordRequestHandler(method, handler) : handler,
            ...rest,
          );
        };
      }

      if (prop === "setNotificationHandler") {
        return (schema: unknown, handler: Fn, ...rest: unknown[]) => {
          const method = methodOf(schema);
          const wrapped = method
            ? (notification: unknown, ...more: unknown[]) => {
                recordNotification(method, notification);
                return handler(notification, ...more);
              }
            : handler;
          return original(schema, wrapped, ...rest);
        };
      }

      return original;
    },
  });
}
