import { VirtualClock, seededIdGenerator, systemClock } from "@shadow/core";
import { describe, expect, it } from "vitest";
import {
  INSERT_CHUNK,
  chunk,
  createServiceContext,
  decodeCursor,
  encodeCursor,
} from "../../src/services/context.js";

describe("cursor encoding", () => {
  it("round-trips sequences", () => {
    for (const sequence of [0, 1, 42, 999_999, 2 ** 31 - 1]) {
      const cursor = encodeCursor(sequence);
      expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(decodeCursor(cursor)).toBe(sequence);
    }
  });

  it("treats a missing cursor as the beginning", () => {
    expect(decodeCursor(undefined)).toBe(-1);
    expect(decodeCursor("")).toBe(-1);
  });

  it("rejects malformed cursors", () => {
    expect(() => decodeCursor("!!!not-base64!!!")).toThrow("invalid cursor");
    expect(() => decodeCursor(Buffer.from("plain text").toString("base64url"))).toThrow(
      "invalid cursor",
    );
    expect(() =>
      decodeCursor(Buffer.from(JSON.stringify({ s: "10" })).toString("base64url")),
    ).toThrow("invalid cursor");
    expect(() =>
      decodeCursor(Buffer.from(JSON.stringify({ s: 1.5 })).toString("base64url")),
    ).toThrow("invalid cursor");
    expect(() =>
      decodeCursor(Buffer.from(JSON.stringify({ other: 1 })).toString("base64url")),
    ).toThrow("invalid cursor");
    expect(() => decodeCursor(Buffer.from("null").toString("base64url"))).toThrow("invalid cursor");
  });
});

describe("chunk", () => {
  it("splits items into fixed-size parts", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
    expect(chunk([1, 2, 3], 3)).toEqual([[1, 2, 3]]);
  });

  it("uses the insert chunk size by default", () => {
    const items = Array.from({ length: INSERT_CHUNK * 2 + 1 }, (_, i) => i);
    const parts = chunk(items);
    expect(parts).toHaveLength(3);
    expect(parts[0]).toHaveLength(INSERT_CHUNK);
    expect(parts[2]).toEqual([INSERT_CHUNK * 2]);
  });
});

describe("createServiceContext", () => {
  const base = {
    handle: {} as never,
    logger: {} as never,
    registry: {} as never,
    redactor: {} as never,
  };

  it("fills in random ids and the system clock by default", () => {
    const ctx = createServiceContext(base);
    expect(ctx.clock).toBe(systemClock);
    const a = ctx.ids.next("trc");
    const b = ctx.ids.next("trc");
    expect(a).toMatch(/^trc_[a-f0-9]{32}$/);
    expect(a).not.toBe(b);
  });

  it("keeps injected ids and clock", () => {
    const clock = new VirtualClock("2026-09-01T00:00:00.000Z");
    const ids = seededIdGenerator("ctx-test");
    const ctx = createServiceContext({ ...base, ids, clock });
    expect(ctx.clock).toBe(clock);
    expect(ctx.ids).toBe(ids);
    expect(ctx.ids.next("evt")).toBe(seededIdGenerator("ctx-test").next("evt"));
  });
});
