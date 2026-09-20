import type { Branch, Comparison } from "@shadow/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MatrixResult } from "../../src/services/matrix.js";
import {
  createTestApp,
  findEvent,
  ingestRefundScenario,
  json,
  type ErrorEnvelope,
  type RefundScenario,
  type TestApp,
} from "../helpers.js";

let t: TestApp;
let scenario: RefundScenario;
let forkEventId: string;

beforeAll(async () => {
  t = await createTestApp();
  scenario = await ingestRefundScenario(t, "trc_matrix");
  forkEventId = findEvent(scenario.rootEvents, "tool.request", "refund_order").id;
});

afterAll(async () => {
  await t.close();
});

describe("POST /traces/:traceId/forks/matrix", () => {
  it("forks, replays and compares every variant", async () => {
    const response = await t.app.inject({
      method: "POST",
      url: `/api/v1/traces/${scenario.traceId}/forks/matrix`,
      payload: {
        forkEventId,
        variants: [
          {
            name: "limit-100",
            overrides: [{ kind: "context", op: "set", key: "refundLimit", value: 100 }],
          },
          {
            name: "limit-500",
            overrides: [{ kind: "context", op: "set", key: "refundLimit", value: 500 }],
          },
          { overrides: [{ kind: "context", op: "set", key: "refundLimit", value: 50 }] },
        ],
      },
    });
    expect(response.statusCode).toBe(201);
    const result = json<MatrixResult>(response);
    expect(result.traceId).toBe(scenario.traceId);
    expect(result.parentBranchId).toBe(scenario.rootBranchId);
    expect(result.variants.map((v) => v.name)).toEqual(["limit-100", "limit-500", "fork-1"]);
    for (const variant of result.variants) {
      expect(variant.replay.status).toBe("completed");
      expect(variant.branch.parentBranchId).toBe(scenario.rootBranchId);
      expect(variant.comparisonId).toMatch(/^cmp_/);
    }
    const [strict, same, stricter] = result.variants;
    // The real limit changes the outcome: approval instead of an autonomous refund.
    expect(strict?.outcome.changed).toBe(true);
    expect(strict?.firstDivergence?.summary).toBeTruthy();
    expect(stricter?.outcome.changed).toBe(true);
    // Re-asserting the limit the agent already believed changes nothing.
    expect(same?.outcome.changed).toBe(false);
    expect(same?.firstDivergence).toBeNull();
    expect(same?.deltas.toolCalls).toBe(0);

    const branches = json<{ items: Branch[] }>(
      await t.app.inject({ method: "GET", url: `/api/v1/traces/${scenario.traceId}/branches` }),
    );
    expect(branches.items).toHaveLength(4);
    const stored = await t.app.inject({
      method: "GET",
      url: `/api/v1/comparisons/${strict?.comparisonId}`,
    });
    expect(json<Comparison>(stored).targetBranchId).toBe(strict?.branch.id);
  });

  it("validates variants and refuses agents that cannot be replayed", async () => {
    const empty = await t.app.inject({
      method: "POST",
      url: `/api/v1/traces/${scenario.traceId}/forks/matrix`,
      payload: { forkEventId, variants: [] },
    });
    expect(empty.statusCode).toBe(400);
    const noOverrides = await t.app.inject({
      method: "POST",
      url: `/api/v1/traces/${scenario.traceId}/forks/matrix`,
      payload: { forkEventId, variants: [{ overrides: [] }] },
    });
    expect(noOverrides.statusCode).toBe(400);
    const duplicate = await t.app.inject({
      method: "POST",
      url: `/api/v1/traces/${scenario.traceId}/forks/matrix`,
      payload: {
        forkEventId,
        variants: [
          { name: "dup", overrides: [{ kind: "context", op: "set", key: "a", value: 1 }] },
          { name: "dup", overrides: [{ kind: "context", op: "set", key: "a", value: 2 }] },
        ],
      },
    });
    expect(duplicate.statusCode).toBe(400);

    const created = await t.app.inject({
      method: "POST",
      url: "/api/v1/traces",
      payload: { project: "p", agent: "unregistered-agent", name: "n" },
    });
    const other = json<{ id: string; rootBranchId: string }>(created);
    await t.app.inject({
      method: "POST",
      url: `/api/v1/traces/${other.id}/events`,
      payload: {
        events: [
          {
            id: "evt_matrix_x",
            eventType: "tool.request",
            name: "x",
            input: { tool: "x", arguments: null },
          },
        ],
      },
    });
    const refused = await t.app.inject({
      method: "POST",
      url: `/api/v1/traces/${other.id}/forks/matrix`,
      payload: {
        forkEventId: "evt_matrix_x",
        variants: [{ overrides: [{ kind: "context", op: "set", key: "a", value: 1 }] }],
      },
    });
    expect(refused.statusCode).toBe(422);
    expect(json<ErrorEnvelope>(refused).error.code).toBe("agent_not_replayable");
    const branches = json<{ items: Branch[] }>(
      await t.app.inject({ method: "GET", url: `/api/v1/traces/${other.id}/branches` }),
    );
    expect(branches.items).toHaveLength(1);
  });
});
