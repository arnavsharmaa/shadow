import { describe, expect, it } from "vitest";
import { InMemoryStateStore } from "../src/index.js";

describe("InMemoryStateStore", () => {
  it("starts from cloned initial state and context", () => {
    const state = { a: { b: 1 } };
    const context = { key: "v" };
    const store = new InMemoryStateStore(state, context, 3);
    state.a.b = 99;
    expect(store.getState()).toEqual({ a: { b: 1 } });
    expect(store.getContext()).toEqual({ key: "v" });
    expect(store.version).toBe(3);
  });

  it("returns copies so callers cannot mutate internal state", () => {
    const store = new InMemoryStateStore({ list: [1] });
    const snapshot = store.getState();
    (snapshot.list as number[]).push(2);
    expect(store.getState()).toEqual({ list: [1] });
  });

  it("setState returns an add patch for new paths and a replace patch for existing ones", () => {
    const store = new InMemoryStateStore();
    expect(store.setState("/a/b", 1)).toEqual([{ op: "add", path: "/a/b", value: 1 }]);
    expect(store.version).toBe(1);
    expect(store.setState("/a/b", 2)).toEqual([{ op: "replace", path: "/a/b", value: 2 }]);
    expect(store.version).toBe(2);
    expect(store.getState()).toEqual({ a: { b: 2 } });
  });

  it("is a no-op when setting an identical value", () => {
    const store = new InMemoryStateStore({ a: [1, 2] });
    expect(store.setState("/a", [1, 2])).toBeNull();
    expect(store.version).toBe(0);
  });

  it("removeState only bumps the version when something was removed", () => {
    const store = new InMemoryStateStore({ a: 1, b: 2 });
    expect(store.removeState("/missing")).toBeNull();
    expect(store.version).toBe(0);
    expect(store.removeState("/a")).toEqual([{ op: "remove", path: "/a" }]);
    expect(store.getState()).toEqual({ b: 2 });
    expect(store.version).toBe(1);
  });

  it("replaceState swaps the whole document", () => {
    const store = new InMemoryStateStore({ a: 1 });
    expect(store.replaceState({ a: 1 })).toBeNull();
    expect(store.replaceState({ b: 2 })).toEqual([{ op: "replace", path: "", value: { b: 2 } }]);
    expect(store.getState()).toEqual({ b: 2 });
    expect(store.version).toBe(1);
  });

  it("tracks context changes and reports whether anything changed", () => {
    const store = new InMemoryStateStore();
    expect(store.setContext("k", 1)).toBe(true);
    expect(store.setContext("k", 1)).toBe(false);
    expect(store.setContext("k", 2)).toBe(true);
    expect(store.removeContext("missing")).toBe(false);
    expect(store.removeContext("k")).toBe(true);
    expect(store.getContext()).toEqual({});
    expect(store.version).toBe(3);
  });

  it("load replaces state, context and version", () => {
    const store = new InMemoryStateStore({ a: 1 }, { c: 1 }, 5);
    store.load({ b: 2 }, { d: 2 }, 42);
    expect(store.getState()).toEqual({ b: 2 });
    expect(store.getContext()).toEqual({ d: 2 });
    expect(store.version).toBe(42);
  });
});
