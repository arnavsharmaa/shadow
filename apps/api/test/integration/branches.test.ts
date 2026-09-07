import type { Branch, Fork, ReconstructedState, ShadowEvent, TraceSummary } from "@shadow/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestApp,
  findEvent,
  ingestRefundScenario,
  json,
  listAllEvents,
  type ErrorEnvelope,
  type RefundScenario,
  type TestApp,
} from "../helpers.js";

describe("branch management", () => {
  let t: TestApp;
  let scenario: RefundScenario;

  const getTrace = async () =>
    json<{ trace: TraceSummary; branches: Branch[] }>(
      await t.app.inject({ method: "GET", url: `/api/v1/traces/${scenario.traceId}` }),
    );

  async function createFork(
    payload: Record<string, unknown>,
  ): Promise<{ branch: Branch; fork: Fork }> {
    const response = await t.app.inject({
      method: "POST",
      url: `/api/v1/traces/${scenario.traceId}/forks`,
      payload,
    });
    if (response.statusCode !== 201) throw new Error(response.body);
    return json<{ branch: Branch; fork: Fork }>(response);
  }

  beforeAll(async () => {
    t = await createTestApp();
    scenario = await ingestRefundScenario(t, "trc_test_branches");
  });

  afterAll(async () => {
    await t.close();
  });

  it("fetches a branch by id", async () => {
    const response = await t.app.inject({
      method: "GET",
      url: `/api/v1/branches/${scenario.rootBranchId}`,
    });
    expect(response.statusCode).toBe(200);
    expect(json<Branch>(response)).toMatchObject({
      id: scenario.rootBranchId,
      traceId: scenario.traceId,
      name: "main",
      depth: 0,
    });
    expect(
      (await t.app.inject({ method: "GET", url: "/api/v1/branches/br_missing" })).statusCode,
    ).toBe(404);
  });

  it("renames a branch and updates its metadata", async () => {
    const renamed = await t.app.inject({
      method: "PATCH",
      url: `/api/v1/branches/${scenario.rootBranchId}`,
      payload: { name: "baseline" },
    });
    expect(renamed.statusCode).toBe(200);
    expect(json<Branch>(renamed).name).toBe("baseline");
    expect((await getTrace()).branches[0]?.name).toBe("baseline");

    const withMetadata = await t.app.inject({
      method: "PATCH",
      url: `/api/v1/branches/${scenario.rootBranchId}`,
      payload: { metadata: { owner: "qa", reviewed: true } },
    });
    expect(json<Branch>(withMetadata)).toMatchObject({
      name: "baseline",
      metadata: { owner: "qa", reviewed: true },
    });

    const empty = await t.app.inject({
      method: "PATCH",
      url: `/api/v1/branches/${scenario.rootBranchId}`,
      payload: { name: "" },
    });
    expect(empty.statusCode).toBe(400);
    expect(json<ErrorEnvelope>(empty).error.code).toBe("validation_error");
    expect(
      (
        await t.app.inject({
          method: "PATCH",
          url: "/api/v1/branches/br_missing",
          payload: { name: "x" },
        })
      ).statusCode,
    ).toBe(404);
  });

  it("deletes a fork together with its descendants and updates branchCount", async () => {
    const refund = findEvent(scenario.rootEvents, "tool.request", "refund_order");
    const readCustomer = findEvent(scenario.rootEvents, "tool.request", "read_customer");
    const first = await createFork({ forkEventId: refund.id, overrides: [] });
    const second = await createFork({
      forkEventId: readCustomer.id,
      parentBranchId: first.branch.id,
      overrides: [],
    });
    const sibling = await createFork({
      forkEventId: readCustomer.id,
      overrides: [],
      name: "sibling",
    });
    expect(second.branch).toMatchObject({
      parentBranchId: first.branch.id,
      depth: 2,
      name: "fork-2",
    });
    expect(sibling.branch).toMatchObject({ parentBranchId: scenario.rootBranchId, depth: 1 });
    expect((await getTrace()).trace.branchCount).toBe(4);

    // A grandchild forked from an event inherited from the root only sees the root prefix up to its own fork point.
    const grandchildLineage = await listAllEvents(t, scenario.traceId, {
      branchId: second.branch.id,
    });
    expect(grandchildLineage).toHaveLength(readCustomer.sequence + 1);
    expect(grandchildLineage.slice(0, -1).map((e) => e.id)).toEqual(
      scenario.rootEvents.slice(0, readCustomer.sequence).map((e) => e.id),
    );
    expect(grandchildLineage.at(-1)).toMatchObject({
      eventType: "fork.created",
      branchId: second.branch.id,
      sequence: readCustomer.sequence,
    });
    expect(grandchildLineage.some((e) => e.id === refund.id || e.id === readCustomer.id)).toBe(
      false,
    );
    const grandchildState = json<ReconstructedState>(
      await t.app.inject({ method: "GET", url: `/api/v1/branches/${second.branch.id}/state` }),
    );
    expect(grandchildState.context.customerId).toBe("cus_1001");
    expect(grandchildState.context.refundLimit).toBeUndefined();
    expect(grandchildState.asOfSequence).toBeLessThan(readCustomer.sequence);
    const grandchildTree = json<{ events: ShadowEvent[] }>(
      await t.app.inject({
        method: "GET",
        url: `/api/v1/traces/${scenario.traceId}/tree?branchId=${second.branch.id}`,
      }),
    );
    expect(grandchildTree.events.map((e) => e.id)).toEqual(grandchildLineage.map((e) => e.id));

    const deleted = await t.app.inject({
      method: "DELETE",
      url: `/api/v1/branches/${first.branch.id}`,
    });
    expect(deleted.statusCode).toBe(200);
    expect(json<{ deleted: string[] }>(deleted).deleted).toEqual([
      first.branch.id,
      second.branch.id,
    ]);

    const after = await getTrace();
    expect(after.trace.branchCount).toBe(2);
    expect(after.branches.map((b) => b.id)).toEqual([scenario.rootBranchId, sibling.branch.id]);
    expect(
      (await t.app.inject({ method: "GET", url: `/api/v1/branches/${first.branch.id}` }))
        .statusCode,
    ).toBe(404);
    expect(
      (await t.app.inject({ method: "GET", url: `/api/v1/branches/${second.branch.id}` }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await t.app.inject({
          method: "GET",
          url: `/api/v1/traces/${scenario.traceId}/events?branchId=${first.branch.id}`,
        })
      ).statusCode,
    ).toBe(404);
    const forks = json<{ items: Fork[] }>(
      await t.app.inject({ method: "GET", url: `/api/v1/traces/${scenario.traceId}/forks` }),
    );
    expect(forks.items.map((f) => f.id)).toEqual([sibling.fork.id]);
    expect(
      await listAllEvents(t, scenario.traceId, { branchId: scenario.rootBranchId }),
    ).toHaveLength(scenario.rootEvents.length);

    const again = await createFork({ forkEventId: refund.id, overrides: [] });
    expect(again.branch.name).toBe("fork-1");
    expect((await getTrace()).trace.branchCount).toBe(3);
  });

  it("refuses to delete the root branch", async () => {
    const response = await t.app.inject({
      method: "DELETE",
      url: `/api/v1/branches/${scenario.rootBranchId}`,
    });
    expect(response.statusCode).toBe(422);
    const body = json<ErrorEnvelope>(response);
    expect(body.error.code).toBe("root_branch");
    expect(response.headers["x-request-id"]).toBe(body.error.requestId);
    expect(
      (await t.app.inject({ method: "DELETE", url: "/api/v1/branches/br_missing" })).statusCode,
    ).toBe(404);
    expect((await getTrace()).branches.some((b) => b.id === scenario.rootBranchId)).toBe(true);
  });
});
