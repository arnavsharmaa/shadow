import type { JsonObject, JsonValue, PatchOperation } from "@shadow/schemas";
import { describe, expect, it } from "vitest";
import { applyPatch, createPatch, deepEqual, fnv1a } from "../src/index.js";

describe("applyPatch", () => {
  it("applies add, replace and remove in order", () => {
    const ops: PatchOperation[] = [
      { op: "add", path: "/a", value: { b: 1 } },
      { op: "add", path: "/a/c", value: [1] },
      { op: "replace", path: "/a/b", value: 2 },
      { op: "add", path: "/a/c/-", value: 2 },
      { op: "remove", path: "/a/c/0" },
    ];
    expect(applyPatch({}, ops)).toEqual({ a: { b: 2, c: [2] } });
  });

  it("does not mutate the input document", () => {
    const doc: JsonObject = { a: 1 };
    const next = applyPatch(doc, [{ op: "replace", path: "/a", value: 2 }]);
    expect(doc).toEqual({ a: 1 });
    expect(next).toEqual({ a: 2 });
  });

  it("returns the same document for an empty patch", () => {
    const doc: JsonObject = { a: 1 };
    expect(applyPatch(doc, [])).toBe(doc);
  });

  it("replaces the whole document with a root replace", () => {
    expect(applyPatch({ a: 1 }, [{ op: "replace", path: "", value: { b: 2 } }])).toEqual({ b: 2 });
  });

  it("rejects unknown operations", () => {
    const bogus = { op: "move", path: "/a", from: "/b" } as unknown as PatchOperation;
    expect(() => applyPatch({}, [bogus])).toThrow(/Unsupported patch operation/);
  });
});

describe("createPatch", () => {
  it("returns no operations for equal objects", () => {
    expect(createPatch({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toEqual([]);
  });

  it("emits remove, add and replace at the deepest differing object level", () => {
    const before: JsonObject = { keep: 1, gone: 2, nested: { x: 1, y: { z: 1 } }, arr: [1, 2] };
    const after: JsonObject = { keep: 1, added: 3, nested: { x: 1, y: { z: 2 } }, arr: [1, 3] };
    const ops = createPatch(before, after);
    // Removals first, then additions/replacements in `after` key order.
    expect(ops).toEqual([
      { op: "remove", path: "/gone" },
      { op: "add", path: "/added", value: 3 },
      { op: "replace", path: "/nested/y/z", value: 2 },
      { op: "replace", path: "/arr", value: [1, 3] },
    ]);
  });

  it("escapes keys containing '/' and '~'", () => {
    const ops = createPatch({}, { "a/b": 1, "c~d": 2 });
    expect(ops.map((o) => o.path)).toEqual(["/a~1b", "/c~0d"]);
    expect(applyPatch({}, ops)).toEqual({ "a/b": 1, "c~d": 2 });
  });

  it("replaces when a value changes type", () => {
    expect(createPatch({ a: { b: 1 } }, { a: [1] })).toEqual([
      { op: "replace", path: "/a", value: [1] },
    ]);
    expect(createPatch({ a: null }, { a: { b: 1 } })).toEqual([
      { op: "replace", path: "/a", value: { b: 1 } },
    ]);
  });

  it("round-trips nested removal", () => {
    const before: JsonObject = { a: { b: { c: 1, d: 2 }, e: [1] } };
    const after: JsonObject = { a: { b: { d: 2 } } };
    const ops = createPatch(before, after);
    expect(ops).toContainEqual({ op: "remove", path: "/a/b/c" });
    expect(ops).toContainEqual({ op: "remove", path: "/a/e" });
    expect(applyPatch(before, ops)).toEqual(after);
  });

  it("round-trips generated object pairs (applyPatch(before, createPatch(before, after)) === after)", () => {
    // Deterministic pseudo-random generator so failures reproduce exactly.
    let counter = 0;
    const rand = (seed: string) => () => fnv1a(`${seed}:${counter++}`) / 0x1_0000_0000;
    const next = rand("patch-fuzz");
    const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
    const keys = ["a", "b", "c", "d/e", "f~g"];

    const genValue = (depth: number): JsonValue => {
      const choice =
        depth > 2
          ? pick(["num", "str", "null", "bool"])
          : pick(["num", "str", "null", "bool", "arr", "obj", "obj"]);
      switch (choice) {
        case "num":
          return Math.floor(next() * 5);
        case "str":
          return pick(["x", "y", "z"]);
        case "null":
          return null;
        case "bool":
          return next() > 0.5;
        case "arr":
          return Array.from({ length: Math.floor(next() * 3) }, () => genValue(depth + 1));
        default:
          return genObject(depth + 1);
      }
    };
    const genObject = (depth: number): JsonObject => {
      const out: JsonObject = {};
      for (const key of keys) if (next() > 0.4) out[key] = genValue(depth);
      return out;
    };
    // Mutate a copy of `before` so pairs share structure and exercise nested edits.
    const mutate = (value: JsonValue, depth: number): JsonValue => {
      if (value !== null && typeof value === "object" && !Array.isArray(value) && next() > 0.3) {
        const out: JsonObject = {};
        for (const [key, child] of Object.entries(value)) {
          const roll = next();
          if (roll < 0.2) continue; // remove
          out[key] = roll < 0.6 ? mutate(child, depth + 1) : child;
        }
        if (next() > 0.5) out[pick(keys)] = genValue(depth + 1); // add
        return out;
      }
      return next() > 0.5 ? genValue(depth) : value;
    };

    for (let i = 0; i < 300; i++) {
      const before = genObject(0);
      const after = mutate(before, 0) as JsonObject;
      const ops = createPatch(before, after);
      const result = applyPatch(before, ops);
      expect(deepEqual(result, after), `pair ${i}: ${JSON.stringify({ before, after, ops })}`).toBe(
        true,
      );
    }
  });
});
