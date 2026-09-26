import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createLogger } from "../../src/logger.js";
import { anyValue, type OtlpTracesPayload } from "../../src/otlp/convert.js";
import { createOtlpForwarder } from "../../src/otlp/forwarder.js";
import { decodeOtlpProtobuf } from "../../src/otlp/protobuf.js";
import { createTestApp, ingestRefundScenario, type TestApp } from "../helpers.js";
import { refundPayload } from "../fixtures/otlp.js";

interface Delivery {
  url: string;
  headers: Record<string, string>;
  body: Uint8Array | string;
}

let t: TestApp;
const deliveries: Delivery[] = [];
let responses: number[] = [];

const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
  const body = init?.body;
  deliveries.push({
    url: String(url),
    headers: (init?.headers ?? {}) as Record<string, string>,
    body: body instanceof Uint8Array ? body : String(body),
  });
  const status = responses.shift() ?? 200;
  return new Response(status === 200 ? "{}" : "nope", { status });
}) as unknown as typeof fetch;

function spanNames(payload: OtlpTracesPayload): string[] {
  return (
    payload.resourceSpans?.flatMap(
      (r) => r.scopeSpans?.flatMap((s) => (s.spans ?? []).map((span) => span.name ?? "")) ?? [],
    ) ?? []
  );
}

beforeAll(async () => {
  t = await createTestApp();
  t.services.otlpForwarder = createOtlpForwarder({
    config: {
      SHADOW_OTLP_EXPORT_URL: "http://collector.test:4318/v1/traces",
      SHADOW_OTLP_EXPORT_HEADERS: "authorization=Bearer otel-secret, x-tenant=support",
      SHADOW_OTLP_EXPORT_ENCODING: "protobuf",
    },
    logger: createLogger({ level: "silent" }),
    fetch: fetchImpl,
    maxAttempts: 3,
    backoffMs: 1,
  });
});

afterAll(async () => {
  await t.close();
});

describe("OTLP forwarding on ingestion", () => {
  it("posts the finished trace to the collector as protobuf with the configured headers", async () => {
    const scenario = await ingestRefundScenario(t, "trc_forward");
    await t.services.otlpForwarder.settle();
    expect(deliveries).toHaveLength(1);
    const [delivery] = deliveries;
    expect(delivery?.url).toBe("http://collector.test:4318/v1/traces");
    expect(delivery?.headers).toMatchObject({
      "content-type": "application/x-protobuf",
      "user-agent": "shadow-otlp-exporter",
      authorization: "Bearer otel-secret",
      "x-tenant": "support",
    });
    expect(delivery?.body).toBeInstanceOf(Uint8Array);
    const payload = decodeOtlpProtobuf(delivery?.body as Uint8Array);
    const resource = Object.fromEntries(
      (payload.resourceSpans?.[0]?.resource?.attributes ?? []).map((a) => [
        a.key,
        anyValue(a.value),
      ]),
    );
    expect(resource["shadow.trace.id"]).toBe(scenario.traceId);
    expect(spanNames(payload)).toContain("execute_tool refund_order");
    expect(t.services.metrics.render()).toContain(
      'shadow_otlp_exports_total{result="delivered"} 1',
    );
  });

  it("retries server errors and gives up on client errors without blocking ingestion", async () => {
    deliveries.length = 0;
    responses = [503, 200];
    await ingestRefundScenario(t, "trc_forward_retry", { seed: "t2" });
    await t.services.otlpForwarder.settle();
    expect(deliveries).toHaveLength(2);
    expect(t.services.metrics.render()).toContain(
      'shadow_otlp_exports_total{result="delivered"} 2',
    );

    deliveries.length = 0;
    responses = [400];
    await ingestRefundScenario(t, "trc_forward_rejected", { seed: "t3" });
    await t.services.otlpForwarder.settle();
    expect(deliveries).toHaveLength(1);
    expect(t.services.metrics.render()).toContain('shadow_otlp_exports_total{result="rejected"} 1');

    deliveries.length = 0;
    responses = [500, 500, 500];
    await ingestRefundScenario(t, "trc_forward_failed", { seed: "t4" });
    await t.services.otlpForwarder.settle();
    expect(deliveries).toHaveLength(3);
    expect(t.services.metrics.render()).toContain('shadow_otlp_exports_total{result="failed"} 1');
  });

  it("does not forward traces that arrived through the OTLP endpoint", async () => {
    deliveries.length = 0;
    const response = await t.app.inject({
      method: "POST",
      url: "/api/v1/otlp/v1/traces",
      payload: refundPayload(),
    });
    expect(response.statusCode).toBe(200);
    await t.services.otlpForwarder.settle();
    expect(deliveries).toHaveLength(0);
  });

  it("does nothing when no collector is configured", async () => {
    const off = createOtlpForwarder({
      config: {
        SHADOW_OTLP_EXPORT_URL: undefined,
        SHADOW_OTLP_EXPORT_HEADERS: undefined,
        SHADOW_OTLP_EXPORT_ENCODING: "protobuf",
      },
      logger: createLogger({ level: "silent" }),
      fetch: fetchImpl,
    });
    expect(off.enabled).toBe(false);
    deliveries.length = 0;
    await off.traceFinished(t.services, "trc_forward");
    expect(deliveries).toHaveLength(0);
  });
});
