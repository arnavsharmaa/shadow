import type { BatchJob } from "@shadow/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { batchJobs } from "../../src/db/schema.js";
import {
  failInterruptedJobs,
  runBatchCounterfactual,
  type BatchResult,
} from "../../src/services/batch.js";
import {
  createTestApp,
  ingestRefundScenario,
  json,
  type ErrorEnvelope,
  type TestApp,
} from "../helpers.js";

let t: TestApp;

const body = {
  agent: "refund-agent",
  at: { name: "refund_order" },
  overrides: [{ kind: "context", op: "set", key: "refundLimit", value: 100 }],
};

beforeAll(async () => {
  t = await createTestApp();
  await ingestRefundScenario(t, "trc_job_a", { seed: "ja", startAt: "2026-09-01T09:00:00.000Z" });
  await ingestRefundScenario(t, "trc_job_b", { seed: "jb", startAt: "2026-09-02T09:00:00.000Z" });
  await ingestRefundScenario(t, "trc_job_c", { seed: "jc", startAt: "2026-09-03T09:00:00.000Z" });
});

afterAll(async () => {
  await t.close();
});

async function getJob(id: string): Promise<BatchJob> {
  return json<BatchJob>(await t.app.inject({ url: `/api/v1/batch/jobs/${id}` }));
}

describe("background batch counterfactuals", () => {
  it("queues a job, reports progress and stores the result", async () => {
    const response = await t.app.inject({
      method: "POST",
      url: "/api/v1/batch/counterfactuals",
      payload: { ...body, background: true, branchName: "bg-fix" },
    });
    expect(response.statusCode).toBe(202);
    const job = json<BatchJob>(response);
    expect(job).toMatchObject({ kind: "batch_counterfactual", status: "queued", result: null });
    expect(job.id).toMatch(/^job_/);
    expect(response.headers.location).toBe(`/api/v1/batch/jobs/${job.id}`);
    expect(job.request).toMatchObject({ agent: "refund-agent", background: true });

    await t.services.jobs.settle();
    const done = await getJob(job.id);
    expect(done.status).toBe("completed");
    expect(done.progress).toEqual({
      total: 3,
      done: 3,
      changed: 3,
      unchanged: 0,
      skipped: 0,
      failed: 0,
    });
    expect(done.startedAt).not.toBeNull();
    expect(done.finishedAt).not.toBeNull();
    const result = done.result as unknown as BatchResult;
    expect(result.summary).toEqual({ changed: 3, unchanged: 0, skipped: 0, failed: 0 });
    expect(result.results.map((r) => r.traceId)).toEqual(["trc_job_c", "trc_job_b", "trc_job_a"]);

    const list = json<{ items: BatchJob[] }>(
      await t.app.inject({ url: "/api/v1/batch/jobs?status=completed" }),
    );
    expect(list.items.map((j) => j.id)).toContain(job.id);
    // Lists leave the (possibly large) result out.
    expect(list.items.every((j) => j.result === null)).toBe(true);

    const again = await t.app.inject({
      method: "POST",
      url: `/api/v1/batch/jobs/${job.id}/cancel`,
    });
    expect(again.statusCode).toBe(409);
  });

  it("cancels a queued job before it starts", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Occupy the single runner slot so the next job stays queued.
    t.services.jobs.enqueue("job_blocker", () => gate);
    const response = await t.app.inject({
      method: "POST",
      url: "/api/v1/batch/counterfactuals",
      payload: { ...body, background: true, branchName: "never" },
    });
    const job = json<BatchJob>(response);
    const cancelled = await t.app.inject({
      method: "POST",
      url: `/api/v1/batch/jobs/${job.id}/cancel`,
    });
    expect(cancelled.statusCode).toBe(200);
    expect(json<BatchJob>(cancelled).status).toBe("cancelled");
    release();
    await t.services.jobs.settle();
    const after = await getJob(job.id);
    expect(after).toMatchObject({ status: "cancelled", startedAt: null, result: null });
  });

  it("stops a running batch between traces and keeps the partial result", async () => {
    let checks = 0;
    const result = await runBatchCounterfactual(
      t.services,
      {
        ...body,
        overrides: [{ kind: "context", op: "set", key: "refundLimit", value: 200 }],
        branchName: "partial",
        at: { eventType: "tool.request", name: "refund_order" },
        limit: 20,
        background: true,
      } as Parameters<typeof runBatchCounterfactual>[1],
      { control: { cancelled: () => checks++ >= 1 } },
    );
    expect(result.results).toHaveLength(1);
    expect(result.matched).toBe(3);
  });

  it("allows up to 500 traces in the background but only 50 synchronously", async () => {
    const sync = await t.app.inject({
      method: "POST",
      url: "/api/v1/batch/counterfactuals",
      payload: { ...body, limit: 100 },
    });
    expect(sync.statusCode).toBe(400);
    expect(json<ErrorEnvelope>(sync).error.message).toContain("request validation failed");
    const tooMany = await t.app.inject({
      method: "POST",
      url: "/api/v1/batch/counterfactuals",
      payload: { ...body, limit: 501, background: true },
    });
    expect(tooMany.statusCode).toBe(400);
    const big = await t.app.inject({
      method: "POST",
      url: "/api/v1/batch/counterfactuals",
      payload: { ...body, limit: 500, background: true, branchName: "big" },
    });
    expect(big.statusCode).toBe(202);
    await t.services.jobs.settle();
    expect((await getJob(json<BatchJob>(big).id)).status).toBe("completed");

    const notReplayable = await t.app.inject({
      method: "POST",
      url: "/api/v1/batch/counterfactuals",
      payload: { ...body, agent: "nobody", background: true },
    });
    expect(notReplayable.statusCode).toBe(422);
    expect((await t.app.inject({ url: "/api/v1/batch/jobs/job_missing" })).statusCode).toBe(404);
  });

  it("marks jobs interrupted by a restart as failed", async () => {
    await t.handle.db.insert(batchJobs).values({
      id: "job_interrupted",
      kind: "batch_counterfactual",
      status: "running",
      request: body,
      progress: { total: 3, done: 1 },
    });
    expect(await failInterruptedJobs(t.services)).toBe(1);
    const job = await getJob("job_interrupted");
    expect(job).toMatchObject({
      status: "failed",
      error: "interrupted by an API restart",
      progress: { total: 3, done: 1, changed: 0 },
    });
  });
});
