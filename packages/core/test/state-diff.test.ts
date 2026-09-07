import { describe, expect, it } from "vitest";
import { diffJson, formatDiffPath } from "../src/index.js";

describe("diffJson", () => {
  it("returns nothing for equal values", () => {
    expect(diffJson({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toEqual([]);
    expect(diffJson(undefined, undefined)).toEqual([]);
    expect(diffJson(null, null)).toEqual([]);
  });

  it("reports leaf-level changes only, with sorted keys", () => {
    const entries = diffJson(
      { z: 1, a: { x: 1, y: 2 }, same: { deep: true } },
      { z: 2, a: { x: 1, y: 3 }, same: { deep: true } },
    );
    expect(entries).toEqual([
      { path: "/a/y", op: "changed", before: 2, after: 3 },
      { path: "/z", op: "changed", before: 1, after: 2 },
    ]);
  });

  it("reports added and removed keys", () => {
    expect(diffJson({ a: 1 }, { a: 1, b: { c: 2 } })).toEqual([
      { path: "/b", op: "added", after: { c: 2 } },
    ]);
    expect(diffJson({ a: 1, b: 2 }, { a: 1 })).toEqual([{ path: "/b", op: "removed", before: 2 }]);
  });

  it("walks arrays element by element", () => {
    expect(diffJson({ list: [1, 2, 3] }, { list: [1, 9] })).toEqual([
      { path: "/list/1", op: "changed", before: 2, after: 9 },
      { path: "/list/2", op: "removed", before: 3 },
    ]);
    expect(diffJson([], [{ a: 1 }])).toEqual([{ path: "/0", op: "added", after: { a: 1 } }]);
  });

  it("treats type changes (object vs array, object vs primitive) as a single change", () => {
    expect(diffJson({ a: { b: 1 } }, { a: [1] })).toEqual([
      { path: "/a", op: "changed", before: { b: 1 }, after: [1] },
    ]);
    expect(diffJson({ a: { b: 1 } }, { a: null })).toEqual([
      { path: "/a", op: "changed", before: { b: 1 }, after: null },
    ]);
    expect(diffJson(1, "1")).toEqual([{ path: "", op: "changed", before: 1, after: "1" }]);
  });

  it("reports a root-level add or remove when one side is undefined", () => {
    expect(diffJson(undefined, { a: 1 })).toEqual([{ path: "", op: "added", after: { a: 1 } }]);
    expect(diffJson({ a: 1 }, undefined)).toEqual([{ path: "", op: "removed", before: { a: 1 } }]);
  });

  it("escapes keys and honours a base path", () => {
    expect(diffJson({ "a/b": 1 }, { "a/b": 2 }, "/root")).toEqual([
      { path: "/root/a~1b", op: "changed", before: 1, after: 2 },
    ]);
  });
});

describe("formatDiffPath", () => {
  it("renders pointers as dotted paths", () => {
    expect(formatDiffPath("")).toBe("(root)");
    expect(formatDiffPath("/a/b/0")).toBe("a.b.0");
    expect(formatDiffPath("/a~1b/c~0d")).toBe("a/b.c~d");
  });
});
