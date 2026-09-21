import type {
  Artifact,
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

/**
 * Token for APIs started with SHADOW_API_TOKEN. It is embedded in the browser
 * bundle, which is acceptable for the single-user local mode Shadow ships
 * with; see SECURITY.md before sharing a deployment.
 */
export function apiToken(): string | undefined {
  const value = process.env.NEXT_PUBLIC_SHADOW_API_TOKEN;
  return value && value.length > 0 ? value : undefined;
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
        ...(apiToken() ? { authorization: `Bearer ${apiToken()}` } : {}),
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
  let parsed: unknown;
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

export interface MatrixVariant {
  name: string;
  branch: Branch;
  replay: Replay;
  comparisonId: string;
  outcome: {
    base: { kind: string; label: string } | null;
    target: { kind: string; label: string } | null;
    changed: boolean;
  };
  policyChanged: boolean;
  firstDivergence: { sequence: number; reason: string; summary: string } | null;
  deltas: {
    totalEstimatedCost: number;
    durationMs: number;
    totalTokens: number;
    toolCalls: number;
  };
}

export type BatchItem =
  | ({
      traceId: string;
      traceName: string;
      startedAt: string;
      status: "ok";
      forkEventId: string;
    } & MatrixVariant)
  | {
      traceId: string;
      traceName: string;
      startedAt: string;
      status: "skipped" | "failed";
      reason: string;
    };

export interface BatchResult {
  agent: string;
  matched: number;
  summary: { changed: number; unchanged: number; skipped: number; failed: number };
  results: BatchItem[];
}

export interface AgentStatsRow {
  agentId: string;
  agentSlug: string;
  agentName: string;
  projectSlug: string;
  projectName: string;
  traces: number;
  completed: number;
  failed: number;
  running: number;
  policyViolations: number;
  toolErrors: number;
  avgDurationMs: number | null;
  p95DurationMs: number | null;
  totalEstimatedCost: number;
  avgEstimatedCost: number | null;
  totalTokens: number;
  lastStartedAt: string | null;
}

export const api = {
  agentStats: (filter: { from?: string; to?: string; project?: string } = {}) =>
    request<{ from: string | null; to: string | null; items: AgentStatsRow[] }>(
      "GET",
      `/api/v1/stats/agents${query(filter)}`,
    ),
  listTraces: (filters: TraceFilters) =>
    request<TracePage>(
      "GET",
      `/api/v1/traces${query(filters as Record<string, string | number | undefined>)}`,
    ),
  facets: () => request<Facets>("GET", "/api/v1/traces/facets"),
  trace: (traceId: string) =>
    request<TraceDetail>("GET", `/api/v1/traces/${encodeURIComponent(traceId)}`),
  updateTrace: (
    traceId: string,
    body: {
      name?: string;
      tags?: string[];
      addTags?: string[];
      removeTags?: string[];
      metadata?: Record<string, unknown>;
    },
  ) => request<TraceSummary>("PATCH", `/api/v1/traces/${encodeURIComponent(traceId)}`, body),
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
  batchCounterfactual: (body: {
    agent: string;
    project?: string;
    at: { eventType?: string; name: string };
    overrides: Override[];
    branchName?: string;
    limit?: number;
  }) => request<BatchResult>("POST", "/api/v1/batch/counterfactuals", body),
  forkMatrix: (
    traceId: string,
    body: {
      forkEventId: string;
      parentBranchId?: string;
      variants: { name?: string; overrides: Override[] }[];
    },
  ) =>
    request<{ traceId: string; parentBranchId: string; variants: MatrixVariant[] }>(
      "POST",
      `/api/v1/traces/${encodeURIComponent(traceId)}/forks/matrix`,
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
  createArtifact: (
    traceId: string,
    body: {
      branchId?: string;
      eventId?: string;
      kind: string;
      name: string;
      contentType?: string;
      content: unknown;
    },
  ) => request<Artifact>("POST", `/api/v1/traces/${encodeURIComponent(traceId)}/artifacts`, body),
  artifacts: (traceId: string, filter: { branchId?: string; eventId?: string } = {}) =>
    request<{ items: Artifact[] }>(
      "GET",
      `/api/v1/traces/${encodeURIComponent(traceId)}/artifacts${query({ ...filter, limit: 100 })}`,
    ),
  exportUrl: (traceId: string) =>
    `${apiBaseUrl()}/api/v1/traces/${encodeURIComponent(traceId)}/export`,
  docsUrl: () => `${apiBaseUrl()}/docs`,
  health: () =>
    request<{
      status: string;
      database: { kind: string; location: string; healthy: boolean };
      agents?: { replayable: string[] };
    }>("GET", "/health"),
};
