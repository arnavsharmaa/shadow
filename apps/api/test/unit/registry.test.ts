import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AgentRegistry,
  ReplayModuleError,
  createDefaultRegistry,
  definitionsFromModule,
  loadReplayModules,
  parseModuleList,
} from "../../src/replay/registry.js";

const VALID_MODULE = `
const adapters = () => ({
  model: { complete: () => ({ message: { role: "assistant", content: "ok" } }) },
  tools: { execute: () => ({ result: { ok: true } }) },
  policies: { evaluate: () => ({ decision: "allow" }) },
});
export const definitions = [
  { slug: "custom-agent", name: "Custom Agent", program: async () => ({ kind: "done", label: "Done" }), createAdapters: adapters },
];
export default { slug: "another-agent", name: "Another", program: async () => undefined, createAdapters: adapters };
`;

describe("replay registry modules", () => {
  it("parses the module list relative to a base directory", () => {
    expect(parseModuleList(undefined, "/base")).toEqual([]);
    expect(parseModuleList(" ./a.js, /abs/b.mjs ,", "/base")).toEqual(["/base/a.js", "/abs/b.mjs"]);
  });

  it("collects definitions from default, definition and definitions exports", () => {
    const def = {
      slug: "x",
      name: "X",
      program: async () => undefined,
      createAdapters: () => ({}),
    };
    expect(definitionsFromModule({ default: def }, "m").map((d) => d.slug)).toEqual(["x"]);
    expect(definitionsFromModule({ definition: def, definitions: [def] }, "m")).toHaveLength(2);
    expect(() => definitionsFromModule({}, "m")).toThrow(ReplayModuleError);
    expect(() => definitionsFromModule({ default: { slug: "bad" } }, "m")).toThrow(
      /not an AgentDefinition/,
    );
  });

  it("loads modules from disk and registers every exported agent", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "shadow-replay-"));
    const file = path.join(dir, "agents.mjs");
    await writeFile(file, VALID_MODULE, "utf8");
    const registry = createDefaultRegistry();
    const loaded = await loadReplayModules(registry, [file]);
    expect(loaded).toEqual([{ modulePath: file, slugs: ["another-agent", "custom-agent"] }]);
    expect(registry.has("custom-agent")).toBe(true);
    expect(registry.has("another-agent")).toBe(true);
    expect(registry.has("refund-agent")).toBe(true);
  });

  it("fails clearly when a module is missing or invalid", async () => {
    const registry = new AgentRegistry();
    await expect(loadReplayModules(registry, ["/definitely/missing.mjs"])).rejects.toThrow(
      /could not load replay module/,
    );
    const dir = await mkdtemp(path.join(tmpdir(), "shadow-replay-"));
    const file = path.join(dir, "empty.mjs");
    await writeFile(file, "export const unrelated = 1;", "utf8");
    await expect(loadReplayModules(registry, [file])).rejects.toThrow(
      /exports no agent definition/,
    );
    expect(registry.list()).toHaveLength(0);
  });
});
