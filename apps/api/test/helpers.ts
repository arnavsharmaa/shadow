/**
 * Shared fixtures for the API test-suite.
 *
 * Every test file builds its own isolated app: an in-memory PGlite database,
 * a silent logger and the default replay registry. PGlite instances are fully
 * independent, so files (and vitest workers) never share state.
 */
import {
  createRedactor,
  recordExecution,
  type Clock,
  type IdGenerator,
  type RecordResult,
} from "@shadow/core";
import type {
  Branch,
  Comparison,
  Fork,
  JsonValue,
  OverrideInput,
  Replay,
  ShadowEvent,
} from "@shadow/schemas";
import { demoTraces, refundAgentDefinition, type RefundRequest } from "@shadow/testkit";
import type { LightMyRequestResponse } from "fastify";
import { loadConfig, type ApiConfig } from "../src/config.js";
import { createDatabase, type DatabaseHandle } from "../src/db/client.js";
import { buildApp, type ShadowApp } from "../src/http/app.js";
import { createLogger } from "../src/logger.js";
import { createDefaultRegistry, type AgentRegistry } from "../src/replay/registry.js";
import { seedDemoData, type SeedReport } from "../src/seed/seed.js";
import { createServiceContext, type ServiceContext } from "../src/services/context.js";

export const BASE_TIME = "2026-09-01T09:00:00.000Z";

export interface TestAppOptions {
  /** Extra environment overrides applied on top of the test defaults. */
  env?: Record<string, string>;
  registry?: AgentRegistry;
  ids?: IdGenerator;
  clock?: Clock;
}

export interface TestApp {
  app: ShadowApp;
  handle: DatabaseHandle;
  services: ServiceContext;
  config: ApiConfig;
  /** Seed the deterministic demo data set. */
  seed(): Promise<SeedReport>;
  close(): Promise<void>;
}

export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const handle = await createDatabase({ url: "memory://" });
  await handle.migrate();
  const logger = createLogger({ level: "silent" });
  const services = createServiceContext({
    handle,
    logger,
    registry: options.registry ?? createDefaultRegistry(),
    redactor: createRedactor(),
    ...(options.ids ? { ids: options.ids } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
  });
  const config = loadConfig({
    ...process.env,
    SHADOW_MAX_BODY_BYTES: "1048576",
    SHADOW_AUTO_SEED: "false",
    SHADOW_LOG_LEVEL: "silent",
    ...options.env,
  });
  const app = await buildApp({ config, services, logger });
  await app.ready();
  return {
    app,
    handle,
    services,
    config,
    seed: () => seedDemoData(services),
    close: async () => {
      await app.close();
      await handle.close();
    },
  };
}

/** Throws when a value is missing; avoids non-null assertions in tests. */
export function must<T>(value: T | undefined | null, what = "value"): T {
  if (value === undefined || value === null) throw new Error(`expected ${what} to be present`);
  return value;
}

/** Parse a JSON response body with a caller-supplied shape. */
export function json<T>(response: LightMyRequestResponse): T {
  return response.json() as T;
}

/** Shape of the error envelope returned by the API. */
export interface ErrorEnvelope {
  error: { code: string; message: string; details?: unknown; requestId?: string };
}

/** Find the n-th (1-based) event of a given type and name. */
export function findEvent(
  events: readonly ShadowEvent[],
  eventType: string,
  name?: string,
  occurrence = 1,
): ShadowEvent {
  let seen = 0;
  for (const event of events) {
    if (event.eventType !== eventType) continue;
    if (name !== undefined && event.name !== name) continue;
    seen++;
    if (seen === occurrence) return event;
  }
  throw new Error(`event ${eventType}${name ? ` ${name}` : ""} #${occurrence} not found`);
}

/** The refund-violation demo request (customer asks for a $480 refund). */
export function refundInput(): RefundRequest {
  const spec = must(demoTraces[0], "demo refund trace");
  return spec.input as RefundRequest;
}

/** Record the refund scenario deterministically (seed `t1`, fixed start time). */
export async function recordRefund(
  traceId: string,
  options: { seed?: string; startAt?: string; input?: RefundRequest } = {},
): Promise<RecordResult> {
  return recordExecution({
    definition: refundAgentDefinition,
    input: options.input ?? refundInput(),
    traceId,
    branchId: `${traceId}_root`,
    traceName: "refund-request: defective headphones",
    seed: options.seed ?? "t1",
    startAt: options.startAt ?? BASE_TIME,
    traceMetadata: { customerId: "cus_1001", ticketId: "TCK-1" },
    tags: ["refund", "test"],
  });
}

export interface RefundScenario {
  traceId: string;
  rootBranchId: string;
  recorded: RecordResult;
  /** Events as stored on the root branch (server-normalised). */
  rootEvents: ShadowEvent[];
}

/** Create a trace for the refund agent through the API and ingest its recorded events. */
export async function ingestRefundScenario(
  t: TestApp,
  traceId = "trc_test_refund",
  options: { seed?: string; startAt?: string } = {},
): Promise<RefundScenario> {
  const recorded = await recordRefund(traceId, options);
  const created = await t.app.inject({
    method: "POST",
    url: "/api/v1/traces",
    payload: {
      id: traceId,
      project: "support-agent",
      agent: refundAgentDefinition.slug,
      name: "refund-request: defective headphones",
      startedAt: options.startAt ?? BASE_TIME,
      tags: ["refund", "test"],
      metadata: { customerId: "cus_1001", ticketId: "TCK-1" },
    },
  });
  if (created.statusCode !== 201) throw new Error(`create trace failed: ${created.body}`);
  const { rootBranchId } = json<{ rootBranchId: string }>(created);
  const ingested = await t.app.inject({
    method: "POST",
    url: `/api/v1/traces/${traceId}/events`,
    payload: { events: recorded.events },
  });
  if (ingested.statusCode !== 201) throw new Error(`ingest failed: ${ingested.body}`);
  const rootEvents = await listAllEvents(t, traceId, { branchId: rootBranchId });
  return { traceId, rootBranchId, recorded, rootEvents };
}

export interface ForkedScenario {
  branch: Branch;
  fork: Fork;
  replay: Replay;
  comparison: Comparison;
  /** The `tool.request refund_order` event the fork was created from. */
  forkEvent: ShadowEvent;
}

/**
 * Fork the refund scenario before `refund_order` with the real refund limit,
 * replay it deterministically and compare it against the root branch.
 */
export async function forkReplayCompare(
  t: TestApp,
  scenario: RefundScenario,
  options: { name?: string; overrides?: OverrideInput[] } = {},
): Promise<ForkedScenario> {
  const forkEvent = findEvent(scenario.rootEvents, "tool.request", "refund_order");
  const forked = await t.app.inject({
    method: "POST",
    url: `/api/v1/traces/${scenario.traceId}/forks`,
    payload: {
      forkEventId: forkEvent.id,
      name: options.name,
      overrides: options.overrides ?? [
        { kind: "context", op: "set", key: "refundLimit", value: 100 },
      ],
    },
  });
  if (forked.statusCode !== 201) throw new Error(`fork failed: ${forked.body}`);
  const { branch, fork } = json<{ branch: Branch; fork: Fork }>(forked);
  const replayed = await t.app.inject({
    method: "POST",
    url: `/api/v1/branches/${branch.id}/replay`,
  });
  if (replayed.statusCode !== 201) throw new Error(`replay failed: ${replayed.body}`);
  const { replay, branch: replayedBranch } = json<{ replay: Replay; branch: Branch }>(replayed);
  const compared = await t.app.inject({
    method: "POST",
    url: "/api/v1/comparisons",
    payload: { baseBranchId: scenario.rootBranchId, targetBranchId: branch.id },
  });
  if (compared.statusCode !== 201) throw new Error(`comparison failed: ${compared.body}`);
  return {
    branch: replayedBranch,
    fork,
    replay,
    comparison: json<Comparison>(compared),
    forkEvent,
  };
}

/** Walk the cursor-paginated events endpoint and return every item. */
export async function listAllEvents(
  t: TestApp,
  traceId: string,
  query: { branchId?: string; inherited?: boolean; eventType?: string; limit?: number } = {},
): Promise<ShadowEvent[]> {
  const items: ShadowEvent[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 10_000; guard++) {
    const params = new URLSearchParams();
    params.set("limit", String(query.limit ?? 1000));
    if (query.branchId) params.set("branchId", query.branchId);
    if (query.inherited !== undefined) params.set("inherited", String(query.inherited));
    if (query.eventType) params.set("eventType", query.eventType);
    if (cursor) params.set("cursor", cursor);
    const response = await t.app.inject({
      method: "GET",
      url: `/api/v1/traces/${traceId}/events?${params}`,
    });
    if (response.statusCode !== 200) throw new Error(`list events failed: ${response.body}`);
    const page = json<{ items: ShadowEvent[]; nextCursor: string | null }>(response);
    items.push(...page.items);
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  return items;
}

/** Minimal ingestable event. */
export function ingestEvent(
  eventType: string,
  name: string,
  extra: Record<string, JsonValue | undefined> = {},
): Record<string, JsonValue | undefined> {
  return { eventType, name, ...extra };
}
