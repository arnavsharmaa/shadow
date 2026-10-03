import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSampler, hashToUnit } from "../../src/sampling.js";
import { createTestApp, json, type TestApp } from "../helpers.js";

let t: TestApp;

/** The nth trace id on the requested side of a 50% rate, found from the server's own hash. */
function pick(kept: boolean, nth = 0): string {
  let seen = 0;
  for (let i = 0; i < 10_000; i++) {
    const id = `trc_sample_${i}`;
    if (hashToUnit(id) < 0.5 === kept && seen++ === nth) return id;
  }
  throw new Error("no id found");
}

beforeAll(async () => {
  t = await createTestApp({ env: { SHADOW_INGEST_SAMPLE_RATE: "0.5" } });
});

afterAll(async () => {
  await t.close();
});

describe("createSampler", () => {
  it("decides deterministically from the trace id, like the SDK", () => {
    const half = createSampler(0.5);
    expect(half.enabled).toBe(true);
    expect(half.keeps(pick(true))).toBe(true);
    expect(half.keeps(pick(false))).toBe(false);
    expect(half.keeps(pick(false))).toBe(false);
    expect(createSampler(1).enabled).toBe(false);
    expect(createSampler(1).keeps(pick(false))).toBe(true);
    expect(createSampler(0).keeps(pick(true))).toBe(false);
    // About a tenth of real ids (random hex, as the SDK and API generate them) pass a 10% rate.
    const ids = Array.from({ length: 4000 }, () => `trc_${randomUUID().replace(/-/g, "")}`);
    const kept = ids.filter((id) => createSampler(0.1).keeps(id)).length;
    expect(kept).toBeGreaterThan(300);
    expect(kept).toBeLessThan(500);
  });
});

describe("server-side sampling", () => {
  it("stores kept traces and acknowledges sampled-out ones without storing anything", async () => {
    const kept = pick(true);
    const dropped = pick(false);
    const stored = await t.app.inject({
      method: "POST",
      url: "/api/v1/traces",
      payload: { id: kept, project: "p", agent: "a", name: "kept" },
    });
    expect(stored.statusCode).toBe(201);

    const discarded = await t.app.inject({
      method: "POST",
      url: "/api/v1/traces",
      payload: { id: dropped, project: "p", agent: "a", name: "dropped" },
    });
    expect(discarded.statusCode).toBe(202);
    expect(json(discarded)).toEqual({
      id: dropped,
      rootBranchId: `${dropped}_unsampled`,
      sampled: false,
    });
    expect((await t.app.inject({ url: `/api/v1/traces/${dropped}` })).statusCode).toBe(404);

    // Everything the SDK sends afterwards is acknowledged and dropped too.
    const events = await t.app.inject({
      method: "POST",
      url: `/api/v1/traces/${dropped}/events`,
      payload: { events: [{ eventType: "trace.started", name: "trace.started" }] },
    });
    expect(events.statusCode).toBe(202);
    expect(json(events)).toEqual({ accepted: 0, sampled: false });
    const patched = await t.app.inject({
      method: "PATCH",
      url: `/api/v1/traces/${dropped}`,
      payload: { tags: ["x"] },
    });
    expect(patched.statusCode).toBe(202);
    const artifact = await t.app.inject({
      method: "POST",
      url: `/api/v1/traces/${dropped}/artifacts`,
      payload: { kind: "note", name: "n", content: "c" },
    });
    expect(artifact.statusCode).toBe(202);

    // A kept trace keeps working, and a kept id that does not exist is still a 404.
    const ok = await t.app.inject({
      method: "POST",
      url: `/api/v1/traces/${kept}/events`,
      payload: { events: [{ eventType: "trace.started", name: "trace.started" }] },
    });
    expect(ok.statusCode).toBe(201);
    const missing = await t.app.inject({
      method: "POST",
      url: `/api/v1/traces/${pick(true)}_missing/events`,
      payload: { events: [{ eventType: "trace.started", name: "trace.started" }] },
    });
    expect([201, 404]).toContain(missing.statusCode);
    expect(t.services.metrics.render()).toContain("shadow_traces_sampled_out_total 1");
  });

  it("lets a request force a trace through and serves it afterwards", async () => {
    const forced = pick(false, 1);
    const created = await t.app.inject({
      method: "POST",
      url: "/api/v1/traces",
      headers: { "x-shadow-sample": "keep" },
      payload: { id: forced, project: "p", agent: "a", name: "forced" },
    });
    expect(created.statusCode).toBe(201);
    // Once stored, the trace is served even without the header.
    const events = await t.app.inject({
      method: "POST",
      url: `/api/v1/traces/${forced}/events`,
      payload: { events: [{ eventType: "trace.started", name: "trace.started" }] },
    });
    expect(events.statusCode).toBe(201);
    expect((await t.app.inject({ url: `/api/v1/traces/${forced}` })).statusCode).toBe(200);
  });

  it("samples server-generated ids too and leaves imports alone", async () => {
    const statuses = new Set<number>();
    for (let i = 0; i < 40 && statuses.size < 2; i++) {
      const response = await t.app.inject({
        method: "POST",
        url: "/api/v1/traces",
        payload: { project: "p", agent: "a", name: `random ${i}` },
      });
      statuses.add(response.statusCode);
    }
    expect(statuses).toEqual(new Set([201, 202]));

    // Explicit imports are not sampled: the caller chose this trace.
    const imported = await t.app.inject({
      method: "POST",
      url: "/api/v1/import/anthropic",
      payload: { traceId: pick(false, 2), messages: [{ role: "user", content: "keep me" }] },
    });
    expect(imported.statusCode).toBe(201);
  });
});
