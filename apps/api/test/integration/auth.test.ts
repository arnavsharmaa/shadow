import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "../helpers.js";

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ env: { SHADOW_API_TOKEN: "test-token-123" } });
});

afterAll(async () => {
  await t.close();
});

describe("bearer token authentication", () => {
  it("leaves health and docs open", async () => {
    expect((await t.app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    expect((await t.app.inject({ method: "GET", url: "/openapi.json" })).statusCode).toBe(200);
  });

  it("rejects /api requests without a valid token", async () => {
    const missing = await t.app.inject({ method: "GET", url: "/api/v1/traces" });
    expect(missing.statusCode).toBe(401);
    expect(missing.headers["www-authenticate"]).toContain("Bearer");
    expect(missing.json()).toMatchObject({ error: { code: "unauthorized" } });
    expect(missing.headers["x-request-id"]).toBeTruthy();

    const wrong = await t.app.inject({
      method: "GET",
      url: "/api/v1/traces",
      headers: { authorization: "Bearer nope" },
    });
    expect(wrong.statusCode).toBe(401);

    const basic = await t.app.inject({
      method: "GET",
      url: "/api/v1/traces",
      headers: { authorization: "Basic dGVzdA==" },
    });
    expect(basic.statusCode).toBe(401);

    const write = await t.app.inject({
      method: "POST",
      url: "/api/v1/traces",
      payload: { project: "p", agent: "a", name: "n" },
    });
    expect(write.statusCode).toBe(401);
  });

  it("accepts the configured token", async () => {
    const ok = await t.app.inject({
      method: "GET",
      url: "/api/v1/traces",
      headers: { authorization: "Bearer test-token-123" },
    });
    expect(ok.statusCode).toBe(200);
    const created = await t.app.inject({
      method: "POST",
      url: "/api/v1/traces",
      headers: { authorization: "Bearer test-token-123" },
      payload: { project: "p", agent: "a", name: "n" },
    });
    expect(created.statusCode).toBe(201);
  });
});

describe("without SHADOW_API_TOKEN", () => {
  it("does not require a token", async () => {
    const open = await createTestApp();
    try {
      expect((await open.app.inject({ method: "GET", url: "/api/v1/traces" })).statusCode).toBe(
        200,
      );
    } finally {
      await open.close();
    }
  });
});
