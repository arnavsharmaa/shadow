import protobuf from "protobufjs";
import type { OtlpTracesPayload } from "./convert.js";
import { otlpTraceDescriptor } from "./proto/trace-descriptor.js";

const root = protobuf.Root.fromJSON(otlpTraceDescriptor as unknown as protobuf.INamespace);
const ExportTraceServiceRequest = root.lookupType(
  "opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest",
);

export class OtlpDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OtlpDecodeError";
  }
}

const ID_FIELDS = new Set(["traceId", "spanId", "parentSpanId"]);

/** protobufjs renders bytes as base64; the OTLP JSON encoding uses lowercase hex for ids. */
function base64ToHex(value: string): string {
  return Buffer.from(value, "base64").toString("hex");
}

function hexToBase64(value: string): string {
  return Buffer.from(value, "hex").toString("base64");
}

function mapIds(value: unknown, convert: (id: string) => string): unknown {
  if (Array.isArray(value)) return value.map((item) => mapIds(item, convert));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] =
        ID_FIELDS.has(key) && typeof item === "string" ? convert(item) : mapIds(item, convert);
    }
    return out;
  }
  return value;
}

/**
 * Decode an OTLP/HTTP protobuf body (`application/x-protobuf`) into the same
 * shape as the JSON encoding, so one converter serves both.
 */
export function decodeOtlpProtobuf(body: Uint8Array): OtlpTracesPayload {
  let message: protobuf.Message;
  try {
    message = ExportTraceServiceRequest.decode(body);
  } catch (error) {
    throw new OtlpDecodeError(
      `invalid OTLP protobuf body: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const object = ExportTraceServiceRequest.toObject(message, {
    longs: String,
    enums: Number,
    bytes: String,
    defaults: false,
    arrays: true,
  });
  return mapIds(object, base64ToHex) as OtlpTracesPayload;
}

/** Encode a JSON-shaped payload as OTLP protobuf (used by tests and tooling). */
export function encodeOtlpProtobuf(payload: OtlpTracesPayload): Uint8Array {
  const object = mapIds(payload, hexToBase64) as Record<string, unknown>;
  // fromObject converts JSON-encoding conventions (string int64s, base64 bytes) and throws
  // on shape mismatches; Type#verify would reject the string int64s the JSON encoding uses.
  let message: protobuf.Message;
  try {
    message = ExportTraceServiceRequest.fromObject(object);
  } catch (error) {
    throw new OtlpDecodeError(
      `payload does not match ExportTraceServiceRequest: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return ExportTraceServiceRequest.encode(message).finish();
}
