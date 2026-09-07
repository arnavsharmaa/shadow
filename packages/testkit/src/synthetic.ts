import type { AgentDefinition } from "@shadow/core";
import type { AgentHost, JsonObject, Outcome } from "@shadow/schemas";
import {
  MockToolAdapter,
  RuleBasedPolicyAdapter,
  ScriptedModelAdapter,
  asObject,
} from "./adapters.js";

export interface SyntheticRequest extends JsonObject {
  /** Number of loop iterations; each produces ~5 events. */
  iterations: number;
}

/**
 * Generates large traces for benchmarks and pagination tests. Every
 * iteration does a model call, a tool call and a couple of state updates.
 */
export const syntheticAgentDefinition: AgentDefinition<SyntheticRequest> = {
  slug: "synthetic-load-agent",
  name: "Synthetic Load Agent",
  description: "Generates large deterministic traces for benchmarks.",
  snapshotPolicy: { everyMutations: 200 },
  createAdapters: () => ({
    model: new ScriptedModelAdapter({
      default: (req) => ({
        text: `step ${String(asObject(req.parameters).i)} considered`,
        latencyMs: 5,
      }),
    }),
    tools: new MockToolAdapter({
      compute: (args) => ({ result: { value: Number(asObject(args).i) * 2 }, latencyMs: 3 }),
    }),
    policies: new RuleBasedPolicyAdapter({}),
  }),
  async program(host: AgentHost, input: SyntheticRequest): Promise<Outcome> {
    host.context.set("iterations", input.iterations);
    let total = 0;
    for (let i = 0; i < input.iterations; i++) {
      await host.model({
        provider: "shadow-sim",
        model: "sim-support-mini",
        name: "think",
        messages: [{ role: "user", content: `iteration ${i}` }],
        parameters: { step: "default", i },
      });
      const result = asObject(await host.tool({ name: "compute", arguments: { i } }));
      total += Number(result.value ?? 0);
      host.state.set("/total", total);
      host.state.set("/lastIteration", i);
    }
    return {
      kind: "completed",
      label: `Completed ${input.iterations} iterations`,
      summary: `total=${total}`,
    };
  },
};
