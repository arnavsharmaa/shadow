import { describe, expect, it } from "vitest";
import { ID_PREFIXES, fnv1a, randomIdGenerator, seededIdGenerator } from "../src/index.js";

const ID_SHAPE = /^[a-z]+_[0-9a-f]{24}$/;

describe("seededIdGenerator", () => {
  it("produces the same sequence for the same seed", () => {
    const a = seededIdGenerator("seed-1");
    const b = seededIdGenerator("seed-1");
    const first = Array.from({ length: 20 }, () => a.next("evt"));
    const second = Array.from({ length: 20 }, () => b.next("evt"));
    expect(first).toEqual(second);
  });

  it("produces different sequences for different seeds", () => {
    const a = seededIdGenerator("seed-1").next("evt");
    const b = seededIdGenerator("seed-2").next("evt");
    expect(a).not.toBe(b);
  });

  it("never repeats an id within a generator, even across prefixes", () => {
    const ids = seededIdGenerator("unique");
    const seen = new Set<string>();
    const prefixes = Object.values(ID_PREFIXES);
    for (let i = 0; i < 2000; i++) {
      const prefix = prefixes[i % prefixes.length] ?? "evt";
      const id = ids.next(prefix);
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
    expect(seen.size).toBe(2000);
  });

  it("prefixes ids with the requested entity prefix", () => {
    const ids = seededIdGenerator("prefix");
    expect(ids.next("trc")).toMatch(/^trc_/);
    expect(ids.next("br")).toMatch(/^br_/);
    expect(ids.next("evt")).toMatch(/^evt_/);
    expect(ids.next("spn")).toMatch(ID_SHAPE);
  });

  it("is affected by the position in the sequence, not just the prefix", () => {
    const ids = seededIdGenerator("pos");
    const first = ids.next("evt");
    const second = ids.next("evt");
    expect(first).not.toBe(second);
    // A fresh generator restarts the sequence.
    expect(seededIdGenerator("pos").next("evt")).toBe(first);
  });
});

describe("randomIdGenerator", () => {
  it("produces unique, prefixed ids", () => {
    const ids = randomIdGenerator();
    const generated = new Set(Array.from({ length: 500 }, () => ids.next("evt")));
    expect(generated.size).toBe(500);
    for (const id of generated) expect(id).toMatch(/^evt_[0-9a-f]{32}$/);
  });
});

describe("fnv1a", () => {
  it("is stable and returns an unsigned 32-bit integer", () => {
    expect(fnv1a("")).toBe(0x811c9dc5);
    expect(fnv1a("a")).toBe(fnv1a("a"));
    expect(fnv1a("a")).not.toBe(fnv1a("b"));
    for (const input of ["shadow", "trace", "a much longer string with spaces"]) {
      const hash = fnv1a(input);
      expect(Number.isInteger(hash)).toBe(true);
      expect(hash).toBeGreaterThanOrEqual(0);
      expect(hash).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

describe("ID_PREFIXES", () => {
  it("re-exports the schema prefixes", () => {
    expect(ID_PREFIXES.trace).toBe("trc");
    expect(ID_PREFIXES.event).toBe("evt");
  });
});
