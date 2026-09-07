import type { JsonObject } from "@shadow/schemas";
import { describe, expect, it } from "vitest";
import {
  escapeSegment,
  getAtPointer,
  joinPointer,
  parsePointer,
  removeAtPointer,
  setAtPointer,
} from "../src/index.js";

describe("parsePointer / joinPointer", () => {
  it("treats the empty pointer as the whole document", () => {
    expect(parsePointer("")).toEqual([]);
    expect(joinPointer([])).toBe("");
  });

  it("splits segments and unescapes ~1 and ~0 (RFC 6901)", () => {
    expect(parsePointer("/a/b/0")).toEqual(["a", "b", "0"]);
    expect(parsePointer("/a~1b/c~0d")).toEqual(["a/b", "c~d"]);
    expect(parsePointer("/m~01")).toEqual(["m~1"]);
  });

  it("escapes segments when joining and round-trips", () => {
    expect(escapeSegment("a/b~c")).toBe("a~1b~0c");
    const segments = ["a/b", "c~d", "plain", ""];
    expect(parsePointer(joinPointer(segments))).toEqual(segments);
  });

  it("rejects pointers that do not start with a slash", () => {
    expect(() => parsePointer("a/b")).toThrow(/Invalid JSON pointer/);
  });
});

describe("getAtPointer", () => {
  const doc: JsonObject = { a: { b: [10, { c: "deep" }] }, "x/y": 1, n: null };

  it("reads nested object and array paths", () => {
    expect(getAtPointer(doc, "")).toBe(doc);
    expect(getAtPointer(doc, "/a/b/0")).toBe(10);
    expect(getAtPointer(doc, "/a/b/1/c")).toBe("deep");
    expect(getAtPointer(doc, "/x~1y")).toBe(1);
    expect(getAtPointer(doc, "/n")).toBeNull();
  });

  it("returns undefined for missing paths and non-numeric array indexes", () => {
    expect(getAtPointer(doc, "/missing")).toBeUndefined();
    expect(getAtPointer(doc, "/a/b/9")).toBeUndefined();
    expect(getAtPointer(doc, "/a/b/x")).toBeUndefined();
    expect(getAtPointer(doc, "/a/b/0/c")).toBeUndefined();
    expect(getAtPointer(doc, "/n/child")).toBeUndefined();
  });
});

describe("setAtPointer", () => {
  it("returns a new document and leaves the original untouched", () => {
    const original: JsonObject = { a: { b: 1 }, keep: [1] };
    const next = setAtPointer(original, "/a/b", 2) as JsonObject;
    expect(next).toEqual({ a: { b: 2 }, keep: [1] });
    expect(original).toEqual({ a: { b: 1 }, keep: [1] });
    expect(next).not.toBe(original);
    expect((next as { keep: unknown }).keep).toBe(original.keep);
  });

  it("creates intermediate objects for missing paths", () => {
    expect(setAtPointer({}, "/a/b/c", true)).toEqual({ a: { b: { c: true } } });
    expect(setAtPointer(null, "/a", 1)).toEqual({ a: 1 });
    expect(setAtPointer("scalar", "/a", 1)).toEqual({ a: 1 });
  });

  it("replaces the whole document for the empty pointer", () => {
    expect(setAtPointer({ a: 1 }, "", { b: 2 })).toEqual({ b: 2 });
  });

  it("supports array indexes and the '-' append marker", () => {
    expect(setAtPointer({ list: [1, 2] }, "/list/1", 9)).toEqual({ list: [1, 9] });
    expect(setAtPointer({ list: [1, 2] }, "/list/2", 3)).toEqual({ list: [1, 2, 3] });
    expect(setAtPointer({ list: [1, 2] }, "/list/-", 3)).toEqual({ list: [1, 2, 3] });
    expect(setAtPointer({ list: [{ a: 1 }] }, "/list/0/b", 2)).toEqual({ list: [{ a: 1, b: 2 }] });
  });

  it("rejects out-of-range or non-numeric array indexes", () => {
    expect(() => setAtPointer({ list: [1] }, "/list/5", 1)).toThrow(/Invalid array index/);
    expect(() => setAtPointer({ list: [1] }, "/list/x", 1)).toThrow(/Invalid array index/);
  });

  it("uses escaped keys literally", () => {
    expect(setAtPointer({}, "/a~1b", 1)).toEqual({ "a/b": 1 });
  });
});

describe("removeAtPointer", () => {
  it("removes object keys and array elements immutably", () => {
    const original: JsonObject = { a: { b: 1, c: 2 }, list: [1, 2, 3] };
    expect(removeAtPointer(original, "/a/b")).toEqual({ a: { c: 2 }, list: [1, 2, 3] });
    expect(removeAtPointer(original, "/list/1")).toEqual({ a: { b: 1, c: 2 }, list: [1, 3] });
    expect(original).toEqual({ a: { b: 1, c: 2 }, list: [1, 2, 3] });
  });

  it("removes nested values inside arrays", () => {
    expect(removeAtPointer({ list: [{ a: 1, b: 2 }] }, "/list/0/a")).toEqual({ list: [{ b: 2 }] });
  });

  it("returns the document unchanged when the path is missing", () => {
    const doc: JsonObject = { a: 1, list: [1] };
    // A missing top-level key returns the very same document.
    expect(removeAtPointer(doc, "/missing")).toBe(doc);
    // Missing nested paths leave the content untouched.
    expect(removeAtPointer(doc, "/list/5")).toEqual(doc);
    expect(removeAtPointer(doc, "/list/x")).toEqual(doc);
    expect(removeAtPointer(doc, "/a/b")).toEqual(doc);
    expect(removeAtPointer(null, "/a")).toBeNull();
    expect(removeAtPointer("scalar", "/a")).toBe("scalar");
  });

  it("clears the document for the empty pointer", () => {
    expect(removeAtPointer({ a: 1 }, "")).toEqual({});
  });
});
