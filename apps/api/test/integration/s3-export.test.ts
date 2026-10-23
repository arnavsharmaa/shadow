import { traceExportSchema } from "@shadow/schemas";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createS3Exporter, s3Endpoint, s3ObjectKey } from "../../src/export/s3.js";
import { sha256Hex } from "../../src/export/sigv4.js";
import { createLogger } from "../../src/logger.js";
import { createTestApp, ingestRefundScenario, type TestApp } from "../helpers.js";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

let t: TestApp;
const calls: Call[] = [];
let responses: (() => Response)[] = [];

const config = {
  SHADOW_EXPORT_S3_BUCKET: "shadow-traces",
  SHADOW_EXPORT_S3_ENDPOINT: undefined,
  SHADOW_EXPORT_S3_REGION: "eu-west-1",
  SHADOW_EXPORT_S3_PREFIX: "archive",
  SHADOW_EXPORT_S3_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
  SHADOW_EXPORT_S3_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  SHADOW_EXPORT_S3_SESSION_TOKEN: undefined,
};

const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  calls.push({
    url: String(input),
    method: init?.method ?? "GET",
    headers: (init?.headers ?? {}) as Record<string, string>,
    body: String(init?.body),
  });
  const next = responses.shift();
  return next ? next() : new Response("", { status: 200 });
}) as unknown as typeof fetch;

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await t.close();
});

describe("object storage export", () => {
  it("derives the endpoint and object key", () => {
    expect(
      s3Endpoint({ SHADOW_EXPORT_S3_ENDPOINT: undefined, SHADOW_EXPORT_S3_REGION: "us-east-1" }),
    ).toBe("https://s3.us-east-1.amazonaws.com");
    expect(
      s3Endpoint({ SHADOW_EXPORT_S3_ENDPOINT: "http://minio:9000/", SHADOW_EXPORT_S3_REGION: "x" }),
    ).toBe("http://minio:9000");
    expect(s3ObjectKey("archive", "support-agent", "trc_1")).toBe(
      "archive/support-agent/trc_1.json",
    );
    expect(s3ObjectKey(undefined, "../x", "trc_1")).toBe("__x/trc_1.json");
  });

  it("uploads every finished trace as a signed PUT of its bundle", async () => {
    t.services.s3Exporter = createS3Exporter({
      config,
      logger: createLogger({ level: "silent" }),
      fetch: fetchImpl,
      backoffMs: 1,
      now: () => new Date("2026-10-23T10:00:00Z"),
    });
    expect(t.services.s3Exporter.enabled).toBe(true);
    const scenario = await ingestRefundScenario(t, "trc_test_s3_export", { seed: "s3" });
    await t.services.s3Exporter.settle();

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.method).toBe("PUT");
    expect(call?.url).toBe(
      "https://s3.eu-west-1.amazonaws.com/shadow-traces/archive/support-agent/trc_test_s3_export.json",
    );
    expect(call?.headers["content-type"]).toBe("application/json");
    expect(call?.headers["x-amz-date"]).toBe("20261023T100000Z");
    expect(call?.headers["x-amz-content-sha256"]).toBe(sha256Hex(call?.body ?? ""));
    expect(call?.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20261023\/eu-west-1\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    const bundle = traceExportSchema.parse(JSON.parse(call?.body ?? ""));
    expect(bundle.trace.id).toBe(scenario.traceId);
    expect(bundle.events.length).toBe(scenario.rootEvents.length);
    expect(t.services.metrics.s3Exports.render().join("\n")).toContain(
      'shadow_s3_exports_total{result="written"} 1',
    );
  });

  it("retries server errors and gives up on client errors", async () => {
    calls.length = 0;
    responses = [
      () => new Response("busy", { status: 503 }),
      () => new Response("", { status: 200 }),
    ];
    await ingestRefundScenario(t, "trc_test_s3_retry", { seed: "s3-retry" });
    await t.services.s3Exporter.settle();
    expect(calls.map((c) => c.method)).toEqual(["PUT", "PUT"]);
    expect(calls.every((c) => c.url.endsWith("/trc_test_s3_retry.json"))).toBe(true);

    calls.length = 0;
    responses = [() => new Response("<Error>AccessDenied</Error>", { status: 403 })];
    await ingestRefundScenario(t, "trc_test_s3_denied", { seed: "s3-denied" });
    await t.services.s3Exporter.settle();
    expect(calls).toHaveLength(1);
    const rendered = t.services.metrics.s3Exports.render().join("\n");
    expect(rendered).toContain('shadow_s3_exports_total{result="written"} 2');
    expect(rendered).toContain('shadow_s3_exports_total{result="rejected"} 1');

    // A trace that only started is not uploaded.
    calls.length = 0;
    const started = await t.app.inject({
      method: "POST",
      url: "/api/v1/traces",
      payload: { project: "support-agent", agent: "a", name: "still running" },
    });
    expect(started.statusCode).toBe(201);
    await t.services.s3Exporter.settle();
    expect(calls).toHaveLength(0);
  });

  it("stays off without a bucket and credentials, and reports itself on /health", async () => {
    const off = createS3Exporter({
      config: { ...config, SHADOW_EXPORT_S3_SECRET_ACCESS_KEY: undefined },
      logger: createLogger({ level: "silent" }),
    });
    expect(off.enabled).toBe(false);
    const configured = await createTestApp({
      env: {
        SHADOW_EXPORT_S3_BUCKET: "shadow-traces",
        SHADOW_EXPORT_S3_ENDPOINT: "http://minio:9000",
        SHADOW_EXPORT_S3_PREFIX: "/archive/",
        SHADOW_EXPORT_S3_ACCESS_KEY_ID: "minio",
        SHADOW_EXPORT_S3_SECRET_ACCESS_KEY: "minio-secret",
      },
    });
    try {
      configured.services.s3Exporter = createS3Exporter({
        config: configured.config,
        logger: createLogger({ level: "silent" }),
      });
      const health = await configured.app.inject({ url: "/health" });
      expect(health.json<{ features: { s3Export: unknown } }>().features.s3Export).toEqual({
        enabled: true,
        bucket: "shadow-traces",
        endpoint: "http://minio:9000",
        prefix: "archive",
      });
    } finally {
      await configured.close();
    }
  });
});
