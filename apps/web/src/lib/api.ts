import type {
  Branch,
  Comparison,
  Fork,
  Override,
  ReconstructedState,
  Replay,
  ShadowEvent,
  TraceSummary,
  DiffEntry,
  TraceListQuery,
} from "@shadow/schemas";

export function apiBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_SHADOW_API_URL ?? "http://localhost:4000").replace(/\/+$/, "");
}

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl()}${path}`, {
      method,
      headers: {
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
  } catch (error) {
    throw new ApiRequestError(
      0,
      "network_error",
      `Cannot reach the Shadow API at ${apiBaseUrl()} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!response.ok) {
    const envelope = (parsed ?? {}) as {
      error?: { code?: string; message?: string; details?: unknown; requestId?: string };
    };
    throw new ApiRequestError(
      response.status,
      envelope.error?.code ?? "http_error",
      envelope.error?.message ?? `Request failed with status ${response.status}`,
      envelope.error?.details,
      envelope.error?.requestId,
    );
  }
  return parsed as T;
}

function query(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const s = search.toString();
  return s ? `?${s}` : "";
}

export interface TracePage {
  items: TraceSummary[];
  nextCursor: string | null;
  total: number;
}

export interface Facets {
  projects: { slug: string; name: string }[];
  agents: { slug: string; name: string; projectSlug: string }[];
  tags: string[];
  tools: string[];
}

export interface TraceDetail {
  trace: TraceSummary;
  branches: Branch[];
}

export interface TreeNode {
  id: string;
  depth: number;
  childCount: number;
  spanDurationMs: number | null;
}

export interface TreeResponse {
  branchId: string;
  events: ShadowEvent[];
  nodes: TreeNode[];
}

export interface EventStateResponse {
  event: { id: string; sequence: number };
  branchId: string;
  before: ReconstructedState & { branchId: string };
  after: ReconstructedState & { branchId: string };
  stateDiff: DiffEntry[];
  contextDiff: DiffEntry[];
}

export type TraceFilters = Partial<Omit<TraceListQuery, "limit" | "cursor">> & {
  limit?: number;
  cursor?: string;
};

export const api = {
  listTraces: (filters: TraceFilters) =>
    request<TracePage>(
      "GET",
      `/api/v1/traces${query(filters as Record<string, string | number | undefined>)}`,
    ),
  facets: () => request<Facets>("GET", "/api/v1/traces/facets"),
  trace: (traceId: string) =>
    request<TraceDetail>("GET", `/api/v1/traces/${encodeURIComponent(traceId)}`),
  deleteTrace: (traceId: string) =>
    request<void>("DELETE", `/api/v1/traces/${encodeURIComponent(traceId)}`),
  tree: (traceId: string, branchId?: string) =>
    request<TreeResponse>(
      "GET",
      `/api/v1/traces/${encodeURIComponent(traceId)}/tree${query({ branchId })}`,
    ),
  eventState: (traceId: string, eventId: string, branchId?: string) =>
    request<EventStateResponse>(
      "GET",
      `/api/v1/traces/${encodeURIComponent(traceId)}/events/${encodeURIComponent(eventId)}/state${query({ branchId })}`,
    ),
  branchState: (branchId: string, sequence?: number) =>
    request<ReconstructedState & { branchId: string }>(
      "GET",
      `/api/v1/branches/${encodeURIComponent(branchId)}/state${query({ sequence })}`,
    ),
  branches: (traceId: string) =>
    request<{ items: Branch[] }>("GET", `/api/v1/traces/${encodeURIComponent(traceId)}/branches`),
  forks: (traceId: string) =>
    request<{ items: Fork[] }>("GET", `/api/v1/traces/${encodeURIComponent(traceId)}/forks`),
  createFork: (
    traceId: string,
    body: { forkEventId: string; parentBranchId?: string; name?: string; overrides: Override[] },
  ) =>
    request<{ branch: Branch; fork: Fork }>(
      "POST",
      `/api/v1/traces/${encodeURIComponent(traceId)}/forks`,
      body,
    ),
  replay: (branchId: string) =>
    request<{ replay: Replay; branch: Branch }>(
      "POST",
      `/api/v1/branches/${encodeURIComponent(branchId)}/replay`,
      { mode: "deterministic" },
    ),
  updateBranch: (branchId: string, body: { name?: string }) =>
    request<Branch>("PATCH", `/api/v1/branches/${encodeURIComponent(branchId)}`, body),
  deleteBranch: (branchId: string) =>
    request<{ deleted: string[] }>("DELETE", `/api/v1/branches/${encodeURIComponent(branchId)}`),
  createComparison: (baseBranchId: string, targetBranchId: string) =>
    request<Comparison>("POST", "/api/v1/comparisons", { baseBranchId, targetBranchId }),
  comparison: (comparisonId: string) =>
    request<Comparison>("GET", `/api/v1/comparisons/${encodeURIComponent(comparisonId)}`),
  comparisons: (traceId: string) =>
    request<{ items: Comparison[] }>("GET", `/api/v1/comparisons${query({ traceId, limit: 100 })}`),
  exportUrl: (traceId: string) =>
    `${apiBaseUrl()}/api/v1/traces/${encodeURIComponent(traceId)}/export`,
  docsUrl: () => `${apiBaseUrl()}/docs`,
  health: () =>
    request<{ status: string; database: { kind: string; location: string; healthy: boolean } }>(
      "GET",
      "/health",
    ),
};
