# @shadow/testkit

Deterministic agents, mock adapters and demo data for [Shadow](../../README.md). Used by the seed, the tests, the examples and the replay registry.

- Scenarios: `refundAgentDefinition`, `inventoryAgentDefinition`, `faqAgentDefinition`, `enrichmentAgentDefinition`, `accessAgentDefinition`, `syntheticAgentDefinition`.
- Adapters: `ScriptedModelAdapter`, `MockToolAdapter`, `RuleBasedPolicyAdapter`, `pendingApprovals`, `approvingAfter`.
- Demo data: `demoTraces`, `DEMO_TRACE_IDS`, `scenarioDefinitions`, `findScenario`.
- Helpers: `withAdapters(host, adapters)`, `withDefinition(host, definition)` to run a scenario program under the SDK.

All scenarios run without network access or API keys and produce byte-identical traces for the same seed and start time.

License: Apache-2.0
