import { describe, expect, it } from "vitest";
import { createTestApp, json, type ErrorEnvelope } from "../helpers.js";

describe("rate limiting", () => {
  it("is off by default", async () => {
    const t = await createTestApp();
    try {
      for (let i = 0; i < 5; i++) {
        const response = await t.app.inject({ method: "GET", url: "/api/v1/traces" });
        expect(response.statusCode).toBe(200);
        expect(response.headers["x-ratelimit-limit"]).toBeUndefined();
      }
    } finally {
      await t.close();
    }
  });

  it("answers 429 with the error envelope once the per-minute budget is spent", async () => {
    const t = await createTestApp({ env: { SHADOW_RATE_LIMIT_PER_MINUTE: "3" } });
    try {
      for (let i = 0; i < 3; i++) {
        const ok = await t.app.inject({ method: "GET", url: "/api/v1/traces" });
        expect(ok.statusCode).toBe(200);
        expect(ok.headers["x-ratelimit-limit"]).toBe("3");
        expect(ok.headers["x-ratelimit-remaining"]).toBe(String(2 - i));
      }
      const limited = await t.app.inject({ method: "GET", url: "/api/v1/traces" });
      expect(limited.statusCode).toBe(429);
      expect(limited.headers["retry-after"]).toBeTruthy();
      const body = json<ErrorEnvelope & { error: { details: { max: number } } }>(limited);
      expect(body.error.code).toBe("rate_limited");
      expect(body.error.details.max).toBe(3);
      expect(body.error.requestId).toMatch(/^req_/);
      expect(limited.headers["x-request-id"]).toBe(body.error.requestId);

      // Writes share the same budget; operational endpoints are exempt.
      const write = await t.app.inject({
        method: "POST",
        url: "/api/v1/traces",
        payload: { project: "p", agent: "a", name: "n" },
      });
      expect(write.statusCode).toBe(429);
      expect((await t.app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
      expect((await t.app.inject({ method: "GET", url: "/metrics" })).statusCode).toBe(200);
      expect((await t.app.inject({ method: "GET", url: "/openapi.json" })).statusCode).toBe(200);

      const metrics = await t.app.inject({ method: "GET", url: "/metrics" });
      expect(metrics.body).toMatch(/shadow_http_requests_total\{[^}]*status="429"\} [1-9]/);
    } finally {
      await t.close();
    }
  });
});
