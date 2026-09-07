import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, json, type ErrorEnvelope, type TestApp } from "../helpers.js";

describe("health and error envelope", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  it("GET /health reports ok with database info", async () => {
    const response = await t.app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    const body = json<{
      status: string;
      version: string;
      uptimeSeconds: number;
      database: { kind: string; location: string; healthy: boolean };
    }>(response);
    expect(body.status).toBe("ok");
    expect(body.version).toBe("0.1.0");
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(body.database).toEqual({ kind: "pglite", location: "pglite:memory", healthy: true });
    expect(response.headers["x-request-id"]).toMatch(/^req_[a-f0-9]{20}$/);
  });

  it("returns the not_found envelope for unknown routes", async () => {
    const response = await t.app.inject({ method: "GET", url: "/api/v1/nothing-here" });
    expect(response.statusCode).toBe(404);
    const body = json<ErrorEnvelope>(response);
    expect(body.error.code).toBe("not_found");
    expect(body.error.message).toContain("GET /api/v1/nothing-here");
    expect(body.error.requestId).toMatch(/^req_/);
    expect(response.headers["x-request-id"]).toBe(body.error.requestId);
  });

  it("echoes a caller supplied x-request-id", async () => {
    const response = await t.app.inject({
      method: "GET",
      url: "/api/v1/traces/trc_missing",
      headers: { "x-request-id": "client-req-42" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.headers["x-request-id"]).toBe("client-req-42");
    expect(json<ErrorEnvelope>(response).error.requestId).toBe("client-req-42");
  });

  it("carries x-request-id on validation errors", async () => {
    const response = await t.app.inject({ method: "POST", url: "/api/v1/traces", payload: {} });
    expect(response.statusCode).toBe(400);
    const body = json<ErrorEnvelope>(response);
    expect(body.error.code).toBe("validation_error");
    expect(Array.isArray(body.error.details)).toBe(true);
    expect(response.headers["x-request-id"]).toBe(body.error.requestId);
  });

  it("rejects unsupported media types", async () => {
    const response = await t.app.inject({
      method: "POST",
      url: "/api/v1/traces",
      headers: { "content-type": "application/xml" },
      payload: "<trace/>",
    });
    expect(response.statusCode).toBe(415);
    const body = json<ErrorEnvelope>(response);
    expect(body.error.code).toBe("unsupported_media_type");
    expect(response.headers["x-request-id"]).toBe(body.error.requestId);
  });

  it("rejects malformed JSON with a 4xx envelope", async () => {
    const response = await t.app.inject({
      method: "POST",
      url: "/api/v1/traces",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    expect(response.statusCode).toBe(400);
    const body = json<ErrorEnvelope>(response);
    expect(typeof body.error.code).toBe("string");
    expect(body.error.requestId).toBeDefined();
    expect(response.headers["x-request-id"]).toBe(body.error.requestId);
  });

  it("serves the OpenAPI document", async () => {
    const response = await t.app.inject({ method: "GET", url: "/openapi.json" });
    expect(response.statusCode).toBe(200);
    const body = json<{ openapi: string; paths: Record<string, unknown>; info: { title: string } }>(
      response,
    );
    expect(body.openapi).toBe("3.1.0");
    expect(body.info.title).toBe("Shadow API");
    for (const route of [
      "/api/v1/traces",
      "/api/v1/traces/{traceId}/events",
      "/api/v1/traces/{traceId}/forks",
      "/api/v1/branches/{branchId}/replay",
      "/api/v1/comparisons",
      "/api/v1/traces/import",
    ]) {
      expect(body.paths, route).toHaveProperty(route);
    }
  });

  it("answers CORS preflight for the configured origin", async () => {
    const response = await t.app.inject({
      method: "OPTIONS",
      url: "/api/v1/traces",
      headers: { origin: "http://localhost:3000", "access-control-request-method": "POST" },
    });
    expect(response.statusCode).toBeLessThan(300);
    expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
  });
});
