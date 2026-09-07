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
