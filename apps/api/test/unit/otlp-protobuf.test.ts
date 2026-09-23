import { describe, expect, it } from "vitest";
import { convertOtlpTraces } from "../../src/otlp/convert.js";
import {
  decodeOtlpProtobuf,
  encodeOtlpProtobuf,
  OtlpDecodeError,
} from "../../src/otlp/protobuf.js";
import { refundPayload } from "../fixtures/otlp.js";

describe("OTLP protobuf", () => {
  it("round-trips the JSON fixture through the protobuf encoding", () => {
    const encoded = encodeOtlpProtobuf(refundPayload());
    expect(encoded.length).toBeGreaterThan(200);
    const decoded = decodeOtlpProtobuf(encoded);
    const span = decoded.resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.[0];
    expect(span?.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(span?.spanId).toBe("00f067aa0ba902b7");
    expect(span?.kind).toBe(2);
    expect(String(span?.startTimeUnixNano)).toBe("1788253924000000000");
    expect(span?.status).toEqual({ code: 2, message: "refund exceeded limit" });
    const child = decoded.resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.[1];
    expect(child?.parentSpanId).toBe("00f067aa0ba902b7");
    const attrs = Object.fromEntries((child?.attributes ?? []).map((a) => [a.key, a.value]));
    expect(attrs["gen_ai.request.model"]).toEqual({ stringValue: "shadow-sim-large" });
    expect(attrs["gen_ai.usage.input_tokens"]).toEqual({ intValue: "120" });
    expect(attrs["gen_ai.request.temperature"]).toEqual({ doubleValue: 0.2 });

    // The converter produces the same trace from either encoding.
    const fromJson = convertOtlpTraces(refundPayload(), { defaultProject: "otel" });
    const fromProto = convertOtlpTraces(decoded, { defaultProject: "otel" });
    expect(fromProto.map((t) => t.events.map((e) => [e.id, e.eventType, e.name]))).toEqual(
      fromJson.map((t) => t.events.map((e) => [e.id, e.eventType, e.name])),
    );
    expect(fromProto[0]?.events[3]?.tokenUsage).toEqual(fromJson[0]?.events[3]?.tokenUsage);
  });

  it("rejects bytes that are not an ExportTraceServiceRequest", () => {
    expect(() => decodeOtlpProtobuf(new Uint8Array([0xff, 0xff, 0xff]))).toThrow(OtlpDecodeError);
    expect(() =>
      encodeOtlpProtobuf({ resourceSpans: [{ scopeSpans: "nope" as unknown as [] }] }),
    ).toThrow(OtlpDecodeError);
  });
});
