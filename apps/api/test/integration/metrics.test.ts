import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestApp,
  forkReplayCompare,
  ingestRefundScenario,
  type TestApp,
} from "../helpers.js";

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await t.close();
});

describe("GET /metrics", () => {
  it("exposes request, ingestion, replay and storage metrics in Prometheus format", async () => {
    const scenario = await ingestRefundScenario(t, "trc_metrics_scrape");
    await forkReplayCompare(t, scenario);
    await t.app.inject({ method: "GET", url: "/api/v1/traces/trc_nope" });

    const response = await t.app.inject({ method: "GET", url: "/metrics" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.headers["content-type"]).toContain("version=0.0.4");
    const text = response.body;
    expect(text).toContain('shadow_traces_created_total{source="api"} 1');
    expect(text).toMatch(/shadow_events_ingested_total\{source="sdk"\} \d+/);
    expect(text).toContain("shadow_forks_total 1");
    expect(text).toContain('shadow_replays_total{status="completed"} 1');
    expect(text).toContain('shadow_comparisons_total{kind="branch"} 1');
    expect(text).toContain(
      'shadow_http_requests_total{method="GET",route="/api/v1/traces/:traceId",status="404"} 1',
    );
    expect(text).toContain(
      'shadow_http_requests_total{method="POST",route="/api/v1/traces/:traceId/events",status="201"} 1',
    );
    expect(text).toMatch(
      /shadow_http_request_duration_ms_count\{method="POST",route="\/api\/v1\/traces"\} 1/,
    );
    expect(text).toContain("shadow_traces 1");
    expect(text).toContain("shadow_branches 2");
    expect(text).toMatch(/shadow_events \d+/);
    expect(text).toMatch(/shadow_replayable_agents [1-9]\d*/);
    // The scrape itself is not counted.
    expect(text).not.toContain('route="/metrics"');
  });

  it("requires the bearer token when one is configured", async () => {
    const secured = await createTestApp({ env: { SHADOW_API_TOKEN: "scrape-me" } });
    try {
      expect((await secured.app.inject({ method: "GET", url: "/metrics" })).statusCode).toBe(401);
      const ok = await secured.app.inject({
        method: "GET",
        url: "/metrics",
        headers: { authorization: "Bearer scrape-me" },
      });
      expect(ok.statusCode).toBe(200);
      expect((await secured.app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    } finally {
      await secured.close();
    }
  });
});
