import { describe, expect, it } from "vitest";
import {
  asJsonObject,
  deepClone,
  deepEqual,
  isJsonObject,
  stableStringify,
  toJson,
} from "../src/index.js";

describe("deepEqual", () => {
  it("compares primitives and null", () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual("a", "a")).toBe(true);
    expect(deepEqual(null, null)).toBe(true);
    expect(deepEqual(1, "1")).toBe(false);
    expect(deepEqual(null, {})).toBe(false);
    expect(deepEqual({}, null)).toBe(false);
    expect(deepEqual(undefined, null)).toBe(false);
  });

  it("compares objects structurally regardless of key order", () => {
    expect(deepEqual({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqual({ a: 1, b: 2 }, { a: 1, c: 2 })).toBe(false);
    expect(deepEqual({ a: { x: 1 } }, { a: { x: 2 } })).toBe(false);
  });

  it("compares arrays element-wise and never equates arrays with objects", () => {
    expect(deepEqual([1, [2, 3]], [1, [2, 3]])).toBe(true);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(deepEqual([], {})).toBe(false);
    expect(deepEqual({}, [])).toBe(false);
  });
});

describe("stableStringify", () => {
  it("sorts object keys at every depth", () => {
    const value = { b: 1, a: { z: true, y: [{ k: 1, j: 2 }] } };
    expect(stableStringify(value)).toBe('{"a":{"y":[{"j":2,"k":1}],"z":true},"b":1}');
  });

  it("is identical for structurally equal values with different key order", () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });

  it("handles primitives, null and undefined", () => {
    expect(stableStringify(null)).toBe("null");
    expect(stableStringify("x")).toBe('"x"');
    expect(stableStringify(3.5)).toBe("3.5");
    expect(stableStringify(undefined)).toBe("undefined");
    expect(stableStringify([])).toBe("[]");
  });
});

describe("toJson", () => {
  it("returns plain JSON and drops undefined properties", () => {
    expect(toJson({ a: 1, b: undefined, c: [1, undefined] })).toEqual({ a: 1, c: [1, null] });
    expect(toJson(undefined)).toBeNull();
  });

  it("rejects values that are not JSON serialisable", () => {
    expect(() => toJson(() => 1)).toThrow(TypeError);
    expect(() => toJson(Symbol("s"))).toThrow(/not JSON serialisable/);
  });

  it("turns NaN and Infinity into null rather than producing invalid JSON", () => {
    expect(toJson({ n: Number.NaN, i: Number.POSITIVE_INFINITY })).toEqual({ n: null, i: null });
  });

  it("serialises dates and nested class instances through their JSON form", () => {
    const date = new Date("2026-09-01T09:00:00.000Z");
    expect(toJson({ date })).toEqual({ date: "2026-09-01T09:00:00.000Z" });
  });
});

describe("deepClone", () => {
  it("returns an independent copy of objects and arrays", () => {
    const original = { list: [1, { deep: true }], n: 1 };
    const copy = deepClone(original);
    expect(copy).toEqual(original);
    expect(copy).not.toBe(original);
    expect(copy.list).not.toBe(original.list);
    copy.list.push(2);
    expect(original.list).toHaveLength(2);
  });

  it("returns primitives, null and undefined unchanged", () => {
    expect(deepClone(1)).toBe(1);
    expect(deepClone(null)).toBeNull();
    expect(deepClone(undefined)).toBeUndefined();
  });
});

describe("isJsonObject / asJsonObject", () => {
  it("only accepts plain objects", () => {
    expect(isJsonObject({})).toBe(true);
    expect(isJsonObject([])).toBe(false);
    expect(isJsonObject(null)).toBe(false);
    expect(isJsonObject("x")).toBe(false);
  });

  it("falls back to an empty object", () => {
    expect(asJsonObject({ a: 1 })).toEqual({ a: 1 });
    expect(asJsonObject([1])).toEqual({});
    expect(asJsonObject(undefined)).toEqual({});
  });
});
