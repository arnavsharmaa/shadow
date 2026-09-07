# LangGraph integration

> **Status: design proposal for v0.2. Not implemented in v0.1.** Presented for review; details
> may change. Until an adapter exists, LangGraph applications can be recorded by wrapping node
> logic with `@shadow/sdk` (see [custom-runtime.md](./custom-runtime.md)).

## Goal

Record LangGraph (JavaScript first) graph executions as Shadow traces so that node execution,
state channel updates, checkpoints, interrupts and tool/model calls made inside nodes appear in
the execution tree, and so that the graph state at any superstep can be reconstructed and
overridden in a fork.

LangGraph is a good fit for Shadow's model: its state is explicit (channels), updates are
per-superstep, and checkpoints are natural snapshot points.

## Proposed surface

```ts
import { Shadow } from "@shadow/sdk";
import { shadowCallbacks } from "@shadow/adapter-langgraph";

const shadow = new Shadow({ project: "research", agent: "planner-graph" });
const trace = shadow.startTrace({ name: "run-42" });
await graph.invoke(input, { callbacks: [shadowCallbacks(trace)] });
await trace.end();
```

The adapter is implemented as a LangChain callback handler plus a graph-level hook for
checkpoints; it needs no changes to node code. A second entry point,
`recordCompiledGraph(shadow, graph)`, wraps `invoke`/`stream` and manages the trace lifecycle.

## Mapping

| LangGraph concept                                    | Shadow                                                                                                                                                                                                                                                          |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `graph.invoke` / `graph.stream`                      | One trace; `agent.started` (`name` = graph name, `input.request` = the input) / `agent.completed`                                                                                                                                                               |
| Superstep (one scheduler tick)                       | `langgraph.superstep` event with `{ step, activeNodes }` in `output`                                                                                                                                                                                            |
| Node execution                                       | `langgraph.node_entered` (custom span opener with `spanId`) and `langgraph.node_exited`; `name` = node name. Model and tool calls inside the node carry the node's `spanId`                                                                                     |
| Edge traversal / conditional edge                    | `langgraph.edge` event `{ from, to, conditional: boolean }`; the routing function's return value in `output`                                                                                                                                                    |
| Channel update (state reducer applied)               | `state.patch` on `/<channel>`: `replace` for last-value channels, `add` on `/<channel>/-` for append reducers (`messages`), `name` = the channel pointer                                                                                                        |
| Checkpoint written                                   | `state.snapshot` with the full checkpoint values as `state` and the configurable `config` (thread id, checkpoint id) as `context` keys; `metadata.langgraph.checkpointId`                                                                                       |
| `interrupt()` / `interruptBefore` / `interruptAfter` | `human.approval_requested` with `reason` = the interrupt payload; resumption with `Command(resume=…)` -> `human.approval_resolved` with `decision` derived from the payload (`approved` when truthy, else `rejected`) and the resume value at `state./__resume` |
| Subgraph                                             | Nested agent span (`agent.started` / `agent.completed`) with the subgraph name                                                                                                                                                                                  |
| Chat model call (LangChain `ChatModel`)              | `model.request` (`provider` from the model class, `model` from its identifier, `messages` from LangChain messages, `parameters` from invocation params) / `model.response` (`toolCalls` from `tool_calls`, `tokenUsage` from `usage_metadata`)                  |
| Tool call (`ToolNode` or tool invocation)            | `tool.request` / `tool.response` / `tool.error`, `name` = tool name                                                                                                                                                                                             |
| `Send` (map-reduce fan-out)                          | `langgraph.send` event per dispatch; fan-out branches become sibling node spans                                                                                                                                                                                 |
| Graph-level error                                    | `trace.failed` with the error                                                                                                                                                                                                                                   |
| `RunnableConfig.tags` / `metadata`                   | Trace tags; metadata under `metadata.langgraph`                                                                                                                                                                                                                 |

Run ids from LangChain callbacks are stored in `metadata.langgraph.runId` / `parentRunId` and
used to build `parentSpanId` links.

### State versus context

Graph channels are the program state and map to `state`. Context receives configuration the
graph reads but does not write: `configurable` values (thread id, user id), the graph name, and
any values the adapter is told to lift from state (`liftToContext: ["userTier"]`), so that they
can be targeted by `context` overrides.

## Replay

Recording gives historical inspection and comparison. Deterministic replay requires running the
compiled graph under an `AgentDefinition`:

- the program calls `graph.invoke` with a model instance and tool implementations that delegate
  to the definition's `ModelAdapter` and `ToolAdapter` through the host;
- channel updates are made through `host.state` by the callback handler, so the recorded
  `state.patch` sequence is reproduced;
- checkpoints are replaced by `host.snapshot()` at the same points.

Because LangGraph's scheduler is deterministic for a given sequence of node outputs, replay of
graphs whose nodes only interact with the world through models and tools is expected to be
reliable. Nodes with hidden I/O (direct HTTP calls, reading the clock) will surface as history
mismatches.

## Limitations

- Parallel node execution within a superstep is recorded in completion order.
- Streaming token callbacks are aggregated into one `model.response`.
- Persistent checkpointers (SQLite, Postgres) are observed, not replaced; a replay does not write
  to the application's checkpointer.
- Python LangGraph is out of scope until a Python SDK exists; the bundle format allows an interim
  exporter written in Python.

## Open questions

- Whether `langgraph.node_entered/exited` should be promoted to known event types or remain
  custom.
- Granularity of `state.patch` for large append-only channels (per message versus per
  superstep).
