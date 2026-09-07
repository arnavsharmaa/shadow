import { describe, expect, it } from "vitest";
import {
  EVENT_TYPES,
  eventSchema,
  ingestEventSchema,
  isCompatibleSchemaVersion,
  isKnownEventType,
  overrideSchema,
  parseSchemaVersion,
  patchOperationSchema,
  SCHEMA_VERSION,
  traceExportSchema,
} from "../src/index.js";

const baseEvent = {
  id: "evt_1",
  traceId: "trc_1",
  branchId: "br_1",
  sequence: 0,
  timestamp: "2026-01-01T00:00:00.000Z",
  eventType: "trace.started",
  name: "refund-request",
};

describe("event schema", () => {
  it("applies defaults for optional fields", () => {
    const parsed = eventSchema.parse(baseEvent);
    expect(parsed.schemaVersion).toBe(SCHEMA_VERSION);
    expect(parsed.metadata).toEqual({});
    expect(parsed.tags).toEqual([]);
    expect(parsed.severity).toBe("info");
    expect(parsed.parentEventId).toBeNull();
    expect(parsed.tokenUsage).toBeNull();
  });

  it("accepts unknown event types that follow the category.action convention", () => {
    const parsed = eventSchema.parse({ ...baseEvent, eventType: "langgraph.node_entered" });
    expect(parsed.eventType).toBe("langgraph.node_entered");
    expect(isKnownEventType("langgraph.node_entered")).toBe(false);
    expect(isKnownEventType("tool.request")).toBe(true);
  });

  it("rejects malformed event types, ids and timestamps", () => {
    expect(eventSchema.safeParse({ ...baseEvent, eventType: "NotValid" }).success).toBe(false);
    expect(eventSchema.safeParse({ ...baseEvent, id: "bad id!" }).success).toBe(false);
    expect(eventSchema.safeParse({ ...baseEvent, timestamp: "yesterday" }).success).toBe(false);
    expect(eventSchema.safeParse({ ...baseEvent, sequence: -1 }).success).toBe(false);
  });

  it("preserves unknown top-level fields (forward compatibility)", () => {
    const parsed = eventSchema.parse({ ...baseEvent, futureField: { nested: true } });
    expect((parsed as Record<string, unknown>).futureField).toEqual({ nested: true });
  });

  it("rejects non-JSON payloads", () => {
    expect(eventSchema.safeParse({ ...baseEvent, input: { n: Number.NaN } }).success).toBe(false);
    expect(eventSchema.safeParse({ ...baseEvent, input: { fn: () => 1 } }).success).toBe(false);
  });

  it("lists every documented event type", () => {
    expect(EVENT_TYPES).toContain("fork.created");
    expect(EVENT_TYPES).toContain("policy.approval_required");
    expect(EVENT_TYPES.length).toBe(25);
  });

  it("ingest events may omit server-assigned fields", () => {
    const parsed = ingestEventSchema.parse({ eventType: "tool.request", name: "search_orders" });
    expect(parsed.id).toBeUndefined();
    expect(parsed.sequence).toBeUndefined();
  });
});

describe("schema version", () => {
  it("parses MAJOR.MINOR", () => {
    expect(parseSchemaVersion("1.0")).toEqual({ major: 1, minor: 0 });
    expect(() => parseSchemaVersion("x")).toThrow();
  });
  it("treats same-major versions as compatible", () => {
    expect(isCompatibleSchemaVersion("1.7")).toBe(true);
    expect(isCompatibleSchemaVersion("2.0")).toBe(false);
    expect(isCompatibleSchemaVersion("garbage")).toBe(false);
  });
});

describe("overrides", () => {
  it("parses each override kind with defaults", () => {
    expect(
      overrideSchema.parse({ kind: "context", op: "set", key: "refundLimit", value: 100 }),
    ).toMatchObject({
      kind: "context",
    });
    const tool = overrideSchema.parse({
      kind: "tool_result",
      tool: "inventory.lookup",
      result: { ok: true },
    });
    expect(tool.kind === "tool_result" && tool.occurrence).toBe(1);
    expect(overrideSchema.safeParse({ kind: "state", op: "set", path: "noSlash" }).success).toBe(
      false,
    );
    expect(overrideSchema.safeParse({ kind: "unknown" }).success).toBe(false);
  });
});

describe("patch operations", () => {
  it("validates JSON pointer paths", () => {
    expect(patchOperationSchema.safeParse({ op: "add", path: "/a/b", value: 1 }).success).toBe(
      true,
    );
    expect(patchOperationSchema.safeParse({ op: "remove", path: "a" }).success).toBe(false);
    expect(patchOperationSchema.safeParse({ op: "move", path: "/a" }).success).toBe(false);
  });
});

describe("trace export", () => {
  it("requires the shadow.trace format marker", () => {
    expect(traceExportSchema.safeParse({ format: "other" }).success).toBe(false);
  });
});
