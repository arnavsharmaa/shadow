# @shadow/core

The engine behind [Shadow](../../README.md). Framework-free TypeScript: no Next.js, React, Fastify or database code.

| Area        | Exports                                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------------------------- |
| Events      | `sortEvents`, `assertStrictlyIncreasing`, `buildEventTree`, `flattenTree`, `isErrorEvent`, `isPolicyViolationEvent`    |
| State       | `reconstructState`, `stateAround`, `applyPatch`, `createPatch`, `diffJson`, JSON-pointer helpers, `InMemoryStateStore` |
| Branches    | `resolveLineage`, `effectiveEvents`, `buildBranchTree`, `resolveForkPoint`, `createFork`                               |
| Runtime     | `RuntimeHost` (implements `AgentHost`), `EventLog`, `HistoryCursor`, `recordExecution`, adapter interfaces             |
| Replay      | `createReplay`, `executeReplay`, `ReplayHistoryMismatchError`                                                          |
| Comparison  | `compareBranches`, `diffEventFields`, `summariseToolCalls`, `deriveOutcome`                                            |
| Metrics     | `aggregateMetrics`, `estimateModelCost`, `PricingProvider`, `StaticPricingProvider`                                    |
| Redaction   | `createRedactor`, `DEFAULT_KEY_PATTERNS`, `parsePatternList`                                                           |
| Bundles     | `parseBundle`, `regenerateBundleIds`                                                                                   |
| Determinism | `seededIdGenerator`, `randomIdGenerator`, `VirtualClock`, `systemClock`                                                |

```ts
import {
  recordExecution,
  createFork,
  createReplay,
  executeReplay,
  compareBranches,
  effectiveEvents,
} from "@shadow/core";
```

See [docs/architecture/overview.md](../../docs/architecture/overview.md) and [docs/concepts](../../docs/concepts/events.md).

License: Apache-2.0
