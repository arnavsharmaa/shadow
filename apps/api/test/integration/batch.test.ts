import type { Branch } from "@shadow/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BatchResult } from "../../src/services/batch.js";
import {
  createTestApp,
  ingestRefundScenario,
  json,
  type ErrorEnvelope,
  type TestApp,
} from "../helpers.js";

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
  await ingestRefundScenario(t, "trc_batch_a", { seed: "a", startAt: "2026-09-01T09:00:00.000Z" });
  await ingestRefundScenario(t, "trc_batch_b", { seed: "b", startAt: "2026-09-02T09:00:00.000Z" });
  // A trace of the same agent that never reaches the refund step.
  const bare = await t.app.inject({
    method: "POST",
    url: "/api/v1/traces",
    payload: {
      id: "trc_batch_bare",
      project: "support-agent",
      agent: "refund-agent",
      name: "abandoned",
      startedAt: "2026-09-03T09:00:00.000Z",
    },
  });
  expect(bare.statusCode).toBe(201);
});

afterAll(async () => {
  await t.close();
});

describe("POST /batch/counterfactuals", () => {
  it("applies one override set to every matching trace", async () => {
    const response = await t.app.inject({
      method: "POST",
      url: "/api/v1/batch/counterfactuals",
      payload: {
        agent: "refund-agent",
        at: { name: "refund_order" },
        overrides: [{ kind: "context", op: "set", key: "refundLimit", value: 100 }],
        branchName: "policy-fix",
      },
    });
    expect(response.statusCode).toBe(201);
    const result = json<BatchResult>(response);
    expect(result.agent).toBe("refund-agent");
    expect(result.at).toEqual({ eventType: "tool.request", name: "refund_order" });
    expect(result.matched).toBe(3);
    expect(result.summary).toEqual({ changed: 2, unchanged: 0, skipped: 1, failed: 0 });
    // Newest first.
    expect(result.results.map((r) => r.traceId)).toEqual([
      "trc_batch_bare",
      "trc_batch_b",
      "trc_batch_a",
    ]);
    const [bare, b] = result.results;
    expect(bare).toMatchObject({ status: "skipped" });
    expect(b?.status).toBe("ok");
    if (b?.status === "ok") {
      expect(b.name).toBe("policy-fix");
      expect(b.replay.status).toBe("completed");
      expect(b.outcome.changed).toBe(true);
      expect(b.firstDivergence?.summary).toBeTruthy();
      expect(b.comparisonId).toMatch(/^cmp_/);
      const branches = json<{ items: Branch[] }>(
        await t.app.inject({ method: "GET", url: "/api/v1/traces/trc_batch_b/branches" }),
      );
      expect(branches.items.map((x) => x.name).sort()).toEqual(["main", "policy-fix"]);
    }
  });

  it("reports per-trace failures without aborting and honours filters", async () => {
    // The branch name is taken on a and b now, so a second run with it fails per trace.
    const again = json<BatchResult>(
      await t.app.inject({
        method: "POST",
        url: "/api/v1/batch/counterfactuals",
        payload: {
          agent: "refund-agent",
          at: { name: "refund_order" },
          overrides: [{ kind: "context", op: "set", key: "refundLimit", value: 500 }],
          branchName: "policy-fix",
          from: "2026-09-02T00:00:00.000Z",
          to: "2026-09-02T23:59:59.000Z",
        },
      }),
    );
    expect(again.matched).toBe(1);
    expect(again.summary).toEqual({ changed: 0, unchanged: 0, skipped: 0, failed: 1 });
    expect(again.results[0]).toMatchObject({ traceId: "trc_batch_b", status: "failed" });

    const unchanged = json<BatchResult>(
      await t.app.inject({
        method: "POST",
        url: "/api/v1/batch/counterfactuals",
        payload: {
          agent: "refund-agent",
          at: { name: "refund_order" },
          overrides: [{ kind: "context", op: "set", key: "refundLimit", value: 500 }],
          limit: 1,
          to: "2026-09-01T23:59:59.000Z",
        },
      }),
    );
    expect(unchanged.summary).toEqual({ changed: 0, unchanged: 1, skipped: 0, failed: 0 });
  });

  it("rejects agents without a program and invalid bodies", async () => {
    const refused = await t.app.inject({
      method: "POST",
      url: "/api/v1/batch/counterfactuals",
      payload: {
        agent: "unknown-agent",
        at: { name: "x" },
        overrides: [{ kind: "context", op: "set", key: "a", value: 1 }],
      },
    });
    expect(refused.statusCode).toBe(422);
    expect(json<ErrorEnvelope>(refused).error.code).toBe("agent_not_replayable");
    const invalid = await t.app.inject({
      method: "POST",
      url: "/api/v1/batch/counterfactuals",
      payload: { agent: "refund-agent", at: { name: "refund_order" }, overrides: [], limit: 500 },
    });
    expect(invalid.statusCode).toBe(400);
  });
});
