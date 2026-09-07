# @shadow/schemas

Versioned, vendor-neutral schemas and TypeScript types for [Shadow](../../README.md) traces. Built on Zod 4; no other dependencies.

- Events: `eventSchema`, `ingestEventSchema`, `EVENT_TYPES`, typed payload schemas, `SCHEMA_VERSION`.
- Entities: `projectSchema`, `agentSchema`, `traceSchema`, `branchSchema`, `forkSchema`, `replaySchema`, `artifactSchema`, `branchMetricsSchema`.
- Overrides: `overrideSchema` (context, state, tool_result, tool_error, policy).
- State: `patchOperationSchema`, `stateSnapshotPayloadSchema`, `reconstructedStateSchema`, `diffEntrySchema`.
- Comparison: `comparisonResultSchema`, `firstDivergenceSchema`, `alignedStepSchema`.
- API contracts: request/response schemas for every route, `traceExportSchema`.
- `AgentHost` / `AgentProgram`: the contract shared by the SDK and the replay engine.

Compatibility policy: [docs/concepts/schema-versioning.md](../../docs/concepts/schema-versioning.md).

License: Apache-2.0
