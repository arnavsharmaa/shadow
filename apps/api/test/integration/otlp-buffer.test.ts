import { VirtualClock } from "@shadow/core";
import type { ShadowEvent, TraceSummary } from "@shadow/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../../src/logger.js";
import {
  createOtlpBufferFlusher,
  flushOtlpBuffer,
  type OtlpImportResult,
} from "../../src/otlp/import.js";
import type { OtlpTracesPayload } from "../../src/otlp/convert.js";
import { refundPayload } from "../fixtures/otlp.js";
import { createTestApp, json, listAllEvents, type TestApp } from "../helpers.js";

const ROOT = "00f067aa0ba902b7";
const OTEL_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const clock = new VirtualClock(Date.parse("2026-09-01T10:00:00.000Z"));
let t: TestApp;

/** The fixture restricted to the spans `keep` accepts, under another OTel trace id. */
function batch(keep: (spanId: string) => boolean, otelTraceId = OTEL_ID): OtlpTracesPayload {
  const payload = refundPayload();
  for (const resourceSpans of payload.resourceSpans ?? []) {
    for (const scopeSpans of resourceSpans.scopeSpans ?? []) {
      scopeSpans.spans = (scopeSpans.spans ?? [])
        .filter((span) => keep(span.spanId))
        .map((span) => ({ ...span, traceId: otelTraceId }));
    }
  }
  return payload;
}

const spanCount = (payload: OtlpTracesPayload) =>
  (payload.resourceSpans ?? []).flatMap((r) => (r.scopeSpans ?? []).flatMap((s) => s.spans ?? []))
    .length;

async function send(payload: OtlpTracesPayload) {
  const response = await t.app.inject({ method: "POST", url: "/api/v1/otlp/v1/traces", payload });
  expect(response.statusCode, response.body).toBe(200);
  return json<{ shadow: OtlpImportResult }>(response).shadow.traces;
}

async function trace(otelTraceId: string) {
  const response = await t.app.inject({ url: `/api/v1/traces/trc_otel_${otelTraceId}` });
  return response.statusCode === 200 ? json<{ trace: TraceSummary }>(response).trace : null;
}

beforeAll(async () => {
  t = await createTestApp({ clock, env: { SHADOW_OTLP_BUFFER_SECONDS: "60" } });
});

afterAll(async () => {
  await t.close();
});

describe("OTLP buffering", () => {
  it("holds spans until the root span ends, then stores the trace in one ordered pass", async () => {
    const children = batch((id) => id !== ROOT);
    const first = await send(children);
    expect(first).toEqual([
      {
        traceId: `trc_otel_${OTEL_ID}`,
        otelTraceId: OTEL_ID,
        created: false,
        accepted: 0,
        skipped: 0,
        buffered: spanCount(children),
      },
    ]);
    expect(await trace(OTEL_ID)).toBeNull();
    expect(t.services.otlpBuffer.size).toBe(1);

    // The root span arrives with one child re-sent; the re-sent copy is dropped.
    const second = await send(batch((id) => id === ROOT || id === "a1b2c3d4e5f60001"));
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ created: true, skipped: 0, buffered: 0 });
    expect(t.services.otlpBuffer.size).toBe(0);

    // Same events, same order and no late flags as a one-shot import of the whole fixture.
    const oneShot = "bb".repeat(16);
    const whole = await send(batch(() => true, oneShot));
    expect(whole[0]?.accepted).toBe(second[0]?.accepted);
    const shape = (events: ShadowEvent[]) =>
      events.map((e) => [
        e.sequence,
        e.eventType,
        e.name,
        (e.metadata as { otel?: { late?: boolean } }).otel?.late ?? false,
      ]);
    const buffered = await listAllEvents(t, `trc_otel_${OTEL_ID}`);
    expect(shape(buffered)).toEqual(shape(await listAllEvents(t, `trc_otel_${oneShot}`)));
    expect(buffered.filter((e) => e.eventType.startsWith("trace."))).toHaveLength(2);
    expect((await trace(OTEL_ID))?.status).toBe("failed");
  });

  it("appends spans for a stored trace straight away, as late spans", async () => {
    const payload = batch((id) => id === "a1b2c3d4e5f60003");
    const scope = payload.resourceSpans?.[0]?.scopeSpans?.[0];
    if (!scope?.spans?.[0]) throw new Error("fixture");
    scope.spans[0] = { ...scope.spans[0], spanId: "a1b2c3d4e5f60099" };
    const [late] = await send(payload);
    expect(late).toMatchObject({ created: false, accepted: 2, buffered: 0 });
    expect(t.services.otlpBuffer.size).toBe(0);
  });

  it("stores held spans as they are once the window passes", async () => {
    const otelTraceId = "cc".repeat(16);
    await send(batch((id) => id !== ROOT, otelTraceId));
    clock.advance(59_000);
    expect(await flushOtlpBuffer(t.services)).toEqual([]);
    expect(await trace(otelTraceId)).toBeNull();
    clock.advance(2_000);
    const stored = await flushOtlpBuffer(t.services);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ otelTraceId, created: true, buffered: 0 });
    expect(stored[0]?.accepted).toBeGreaterThan(0);
    expect(await trace(otelTraceId)).not.toBeNull();
    expect(t.services.metrics.render()).toContain(
      'shadow_otlp_buffer_flushes_total{reason="expired"} 1',
    );
    expect(t.services.metrics.render()).toContain(
      'shadow_otlp_buffer_flushes_total{reason="complete"} 1',
    );
  });

  it("stores everything held when the flusher stops", async () => {
    const otelTraceId = "dd".repeat(16);
    await send(batch((id) => id !== ROOT, otelTraceId));
    expect(t.services.otlpBuffer.size).toBe(1);
    const flusher = createOtlpBufferFlusher({
      services: t.services,
      logger: createLogger({ level: "silent" }),
    });
    expect(flusher.enabled).toBe(true);
    flusher.start();
    await flusher.stop();
    expect(t.services.otlpBuffer.size).toBe(0);
    expect(await trace(otelTraceId)).not.toBeNull();
    expect(t.services.metrics.render()).toContain(
      'shadow_otlp_buffer_flushes_total{reason="shutdown"} 1',
    );
  });

  it("is off by default", async () => {
    const plain = await createTestApp();
    try {
      expect(plain.services.otlpBuffer.enabled).toBe(false);
      const response = await plain.app.inject({
        method: "POST",
        url: "/api/v1/otlp/v1/traces",
        payload: batch((id) => id !== ROOT),
      });
      expect(json<{ shadow: OtlpImportResult }>(response).shadow.traces[0]).toMatchObject({
        created: true,
        buffered: 0,
      });
    } finally {
      await plain.close();
    }
  });
});
