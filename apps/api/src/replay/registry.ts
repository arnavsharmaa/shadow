import path from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentDefinition } from "@shadow/core";
import { scenarioDefinitions } from "@shadow/testkit";

/**
 * Programs that can be re-executed for deterministic counterfactual replay.
 *
 * Replay needs the agent's program: Shadow re-runs it against the recorded
 * history and deterministic adapters. Traces recorded by the SDK for agents
 * that are not registered here can still be inspected (historical replay)
 * but cannot be forked and replayed. See docs/concepts/replay-modes.md.
 */
export class AgentRegistry {
  private readonly definitions = new Map<string, AgentDefinition>();

  register(definition: AgentDefinition): void {
    this.definitions.set(definition.slug, definition);
  }

  get(slug: string): AgentDefinition | undefined {
    return this.definitions.get(slug);
  }

  has(slug: string): boolean {
    return this.definitions.has(slug);
  }

  list(): AgentDefinition[] {
    return [...this.definitions.values()];
  }
}

/** Registry pre-populated with the bundled deterministic scenarios. */
export function createDefaultRegistry(): AgentRegistry {
  const registry = new AgentRegistry();
  for (const definition of scenarioDefinitions as unknown as AgentDefinition[]) {
    registry.register(definition);
  }
  return registry;
}

export class ReplayModuleError extends Error {
  constructor(
    message: string,
    readonly modulePath: string,
  ) {
    super(message);
    this.name = "ReplayModuleError";
  }
}

function isDefinition(value: unknown): value is AgentDefinition {
  if (typeof value !== "object" || value === null) return false;
  const d = value as Record<string, unknown>;
  return (
    typeof d.slug === "string" &&
    d.slug.length > 0 &&
    typeof d.name === "string" &&
    typeof d.program === "function" &&
    typeof d.createAdapters === "function"
  );
}

/** Collect definitions from a module's `default`, `definitions` and `definition` exports. */
export function definitionsFromModule(exports: unknown, modulePath: string): AgentDefinition[] {
  const mod = (exports ?? {}) as Record<string, unknown>;
  const candidates: unknown[] = [];
  for (const key of ["default", "definitions", "definition"]) {
    const value = mod[key];
    if (Array.isArray(value)) candidates.push(...value);
    else if (value !== undefined) candidates.push(value);
  }
  if (candidates.length === 0) {
    throw new ReplayModuleError(
      `${modulePath} exports no agent definition (expected a default export, \`definition\` or \`definitions\`)`,
      modulePath,
    );
  }
  return candidates.map((candidate, index) => {
    if (!isDefinition(candidate)) {
      throw new ReplayModuleError(
        `${modulePath}: export #${index + 1} is not an AgentDefinition (needs slug, name, program and createAdapters)`,
        modulePath,
      );
    }
    return candidate;
  });
}

/** Parse the comma-separated SHADOW_REPLAY_MODULES setting. */
export function parseModuleList(list: string | undefined, baseDir: string): string[] {
  if (!list) return [];
  return list
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => path.resolve(baseDir, entry));
}

/**
 * Import operator-provided modules and register the agent definitions they
 * export. The paths come from server configuration, never from request data:
 * this is how a deployment makes its own agents forkable and replayable.
 */
export async function loadReplayModules(
  registry: AgentRegistry,
  modulePaths: readonly string[],
): Promise<{ modulePath: string; slugs: string[] }[]> {
  const loaded: { modulePath: string; slugs: string[] }[] = [];
  for (const modulePath of modulePaths) {
    let exports: unknown;
    try {
      exports = await import(pathToFileURL(modulePath).href);
    } catch (error) {
      throw new ReplayModuleError(
        `could not load replay module ${modulePath}: ${error instanceof Error ? error.message : String(error)}`,
        modulePath,
      );
    }
    const definitions = definitionsFromModule(exports, modulePath);
    for (const definition of definitions) registry.register(definition);
    loaded.push({ modulePath, slugs: definitions.map((d) => d.slug) });
  }
  return loaded;
}
