<!-- studiomeyer-mcp-stack-banner:start -->
> **Part of the [StudioMeyer MCP Stack](https://studiomeyer.io)** — Built in Mallorca 🌴 · ⭐ if you use it
<!-- studiomeyer-mcp-stack-banner:end -->

# darwin-langgraph

> **LangGraph.js adapter for [`darwin-agents`](https://www.npmjs.com/package/darwin-agents).**
> Wrap self-evolving Darwin agents as `StateGraph` nodes — with zero hard deps.

[![npm version](https://img.shields.io/npm/v/darwin-langgraph.svg)](https://www.npmjs.com/package/darwin-langgraph)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

`darwin-langgraph` is a thin, peer-dependency-only bridge between two
independent libraries:

- **[`darwin-agents`](https://www.npmjs.com/package/darwin-agents)** — Darwin
  is an agent framework where prompts evolve themselves via A/B testing,
  multi-model critics, safety gates, and (since `v0.5.0-alpha.1`) full
  execution-trace capture for GEPA-style reflective optimizers.
- **[`@langchain/langgraph`](https://www.npmjs.com/package/@langchain/langgraph)** —
  LangGraph is the state-graph orchestration runtime used by Uber,
  LinkedIn, Klarna, Replit, and others to build multi-step, multi-agent
  workflows with durable execution and human-in-the-loop.

If you use **only Darwin**, you install nothing extra — Darwin itself has
zero LangChain dependency. If you use **only LangGraph**, the same.
If you want to combine the two — let LangGraph orchestrate, let Darwin
evolve — install this adapter.

## Install

```bash
npm install darwin-langgraph @langchain/langgraph darwin-agents
```

Both `@langchain/langgraph` and `darwin-agents` are declared as
**peer-dependencies** — you control the installed versions, the adapter
never pins them.

## Quick start

```ts
import { StateGraph } from "@langchain/langgraph";
import { defineAgent } from "darwin-agents";
import {
  createDarwinNode,
  darwinAnnotation,
  withDarwinEvolution,
} from "darwin-langgraph";

const researcher = defineAgent({
  name: "researcher",
  role: "Topic Researcher",
  description: "Five bullets on a topic.",
  systemPrompt: "Return exactly 5 bullet points.",
});

const graph = withDarwinEvolution(
  new StateGraph(darwinAnnotation())
    .addNode("research", createDarwinNode(researcher))
    .addEdge("__start__", "research")
    .compile(),
  {
    nodeMap: { research: "researcher" },
    onTrajectory: (event) => {
      console.log(
        `${event.nodeName} ran in ${event.trajectory.turnCount} turns ` +
          `with ${event.trajectory.toolCalls.length} tool calls.`,
      );
    },
  },
);

const result = await graph.invoke({ task: "What is GEPA?" });
console.log(result.output);
console.log("trajectory:", result.darwinTrajectory);
```

## Surfaces (11 total)

The adapter exposes 11 public surfaces. Everything is additive across
versions — older code keeps working. The full list (the table notes the
version each surface landed in):

| # | Name | When to use |
|---|---|---|
| 1 | `createDarwinNode(agent, opts?)` | Wrap one Darwin agent as a `StateGraph` node. |
| 2 | `darwinAnnotation(extra?)` | Annotation with `task` + `output` + singleton `darwinTrajectory` channel. |
| 3 | `withDarwinEvolution(graph, opts)` *(deprecated since V0.2)* | Legacy monkey-patch wrapper — migrate to `DarwinCallbackHandler`. |
| 4 | `DarwinCallbackHandler` *(V0.2)* | LangChain-native callback handler with `onTrajectory` + V0.4 `onToolEvent` + V0.4 `maxTrajectoryBytes`. |
| 5 | `toOtelAttributes(trajectory, opts?)` *(V0.2)* | Map an `ExecutionTrace` to OpenTelemetry GenAI Semantic Conventions attributes. V0.4 adds `langGraphNode` / `langGraphStep` / `userId` / `conversationId` / `requestId`. |
| 6 | `darwinMessagesAnnotation(extra?)` *(V0.2)* | Annotation with a `messages` channel for `createReactAgent` interop. |
| 7 | `darwinAccumulatingAnnotation(extra?)` *(V0.4)* | Annotation with an accumulating `darwinTrajectories: ExecutionTrace[]` channel — every node write appends instead of overwriting. |
| 8 | `createTokenBudgetCallbacks(opts)` *(V0.4)* | Production guard — throws `DarwinTokenBudgetExceededError` when a per-invocation token budget is breached. |
| 9 | `toW3CTraceContext(event, opts?)` *(V0.4)* | Pure mapper to a W3C `traceparent` header value for cross-process span correlation. |
| 10 | `MAX_KNOWN_TRACE_VERSION` *(V0.4 const)* | Highest `ExecutionTrace.version` this adapter natively understands; `isExecutionTrace` warns once on higher versions but emits them anyway. |
| 11 | Error classes | `DarwinNodeError` + `DarwinEvolutionHookError` + V0.4 `DarwinTokenBudgetExceededError`. |

### 1. `createDarwinNode(agent, opts?)`

Wraps a Darwin `AgentDefinition` as a LangGraph node action. The returned
function:

1. Reads the task from `state[opts.taskKey ?? "task"]`.
2. Calls `runAgent(agent, task, opts.runOptions)` from `darwin-agents`.
3. Writes the agent's output to `state[opts.outputKey ?? "output"]`.
4. Optionally writes the captured `ExecutionTrace` to
   `state[opts.trajectoryKey ?? "darwinTrajectory"]`.

| Option | Type | Default | Description |
|---|---|---|---|
| `taskKey` | `string` | `"task"` | State property to read the task from. |
| `outputKey` | `string` | `"output"` | State property the output is written to. |
| `trajectoryKey` | `string` | `"darwinTrajectory"` | State property the trace is written to. |
| `runOptions` | object | `{}` | Passthrough for `model`, `maxTurns`, `timeout`, `cwd`, `autonomous`, `config`, `provider`. |
| `captureTrace` | `boolean` | `true` | Set `false` to skip trajectory propagation. |
| `onResult` | function | — | Fire-and-forget side-effect after each run. Errors are swallowed. |

> **`runOptions.provider`** (since V0.5.2) forwards a pre-constructed
> `LLMProvider` straight to `runAgent`, overriding `config.provider`. Use
> it to inject a provider with a custom base URL / shared HTTP agent, or a
> test double. `LLMProvider` is re-exported from `darwin-langgraph` so you
> can build one without a second import.

### 2. `darwinAnnotation(extra?)`

Returns an `Annotation.Root` with three pre-defined channels
(`task` / `output` / `darwinTrajectory`) plus any extra channels you pass
in. Composable:

```ts
const State = darwinAnnotation({
  reviewNotes: Annotation<string[]>({
    reducer: (a, b) => a.concat(b),
    default: () => [],
  }),
});
```

Power-users can spread `getDarwinChannelSpec()` directly into their own
`Annotation.Root({...})` when the helper doesn't fit.

### 3. `withDarwinEvolution(graph, opts)`

Wraps a compiled `StateGraph` with a post-run hook that fires `onTrajectory`
for each node listed in `nodeMap` after every `invoke` / `stream` run.
Errors inside the hook are swallowed — the graph result is always
returned unchanged.

```ts
withDarwinEvolution(graph, {
  nodeMap: {
    research: "researcher",
    critique: { agentName: "critic", trajectoryKey: "critiqueTrace" },
  },
  onTrajectory: (event) => {
    // event.nodeName, event.agentName, event.trajectory, event.finalState
  },
});
```

### Custom errors

```ts
import { DarwinNodeError, DarwinEvolutionHookError } from "darwin-langgraph";

try { await graph.invoke({ task: "..." }); }
catch (err) {
  if (err instanceof DarwinNodeError) {
    console.error(`Node "${err.agentName}" failed:`, err.cause);
  }
}
```

> **GraphInterrupt is re-thrown un-wrapped.** When a downstream node
> calls LangGraph's `interrupt()` for human-in-the-loop, the resulting
> `GraphInterrupt` is surfaced through `createDarwinNode` un-touched so
> the resume protocol (`Command({ resume: ... })`) works. Only non-HITL
> errors get wrapped in `DarwinNodeError`.

### `onResult` vs `onTrajectory` — when to pick which

Both hooks fire after a Darwin agent finishes, but at different layers:

- **`onResult`** (per-node, on `createDarwinNode`) receives the **full
  raw `RunResult`** — including `experiment`, `evolution`, `reportPath`,
  and the raw output. Use it for **per-agent side-effects** that don't
  care about graph structure (e.g. writing to a database, logging the
  full result).
- **`onTrajectory`** (graph-wide, on `withDarwinEvolution`) receives a
  **normalised `DarwinTrajectoryEvent`** with `nodeName`, `agentName`,
  trajectory, and a frozen final-state snapshot. Use it for
  **cross-node observability** that needs to know which LangGraph node
  produced which trace (cost tracking, A/B telemetry, evolution loops).

If you only need per-agent side-effects, use `onResult`. If you need
node-aware telemetry, use `onTrajectory`. They are **not redundant** —
combining both is fine, just be aware they fire at slightly different
points (node-completion vs graph-completion).

### `streamMode` and the trajectory hook

`withDarwinEvolution` wraps both `invoke()` and `stream()`. The hook
reliably fires when:

- You call `graph.invoke({...})` — always works. Internally
  `streamMode: "values"`.
- You call `graph.stream({...})` or `graph.stream({...}, { streamMode:
  "values" })` — works.
- You include `"values"` in a multi-mode array
  (`streamMode: ["values", "updates"]`) — works.

It does **not** fire on `streamMode: "updates"` / `"messages"` /
`"debug"` (without `"values"`) — the last chunk in those modes is a
node-update dict, not the final state, so the trajectory key lookup
silently misses. The adapter logs a `console.warn` (once per process)
the first time it detects a non-`values` stream so you don't silently
lose telemetry. V0.2 will migrate to the LangChain `CallbackHandler`
mechanism which fires regardless of stream mode.

## Examples

The [`examples/`](./examples/) directory ships three runnable scripts:

- [`01-basic-node.ts`](./examples/01-basic-node.ts) — single Darwin node in a 1-edge graph.
- [`02-multi-agent-research.ts`](./examples/02-multi-agent-research.ts) — researcher → critic → writer pipeline with per-node trajectories.
- [`03-hitl-with-darwin.ts`](./examples/03-hitl-with-darwin.ts) — LangGraph `interrupt()` before a Darwin agent runs, with `Command({ resume: ... })` to continue.

## Compatibility matrix

| `darwin-langgraph` | `darwin-agents` | `@langchain/langgraph` | Status |
|---|---|---|---|
| `0.5.3` | `>=0.5.0-alpha.1 <0.11.0` | `^1.3.0 \|\| ^1.4.0` | stable / `latest` (this release) |
| `0.5.0` – `0.5.2` | `>=0.5.0-alpha.1 <0.8.0` | `^1.3.0 \|\| ^1.4.0` | superseded — peer range blocks `darwin-agents ≥ 0.8` installs |
| `0.4.0-alpha.x` | `^0.5.0-alpha.1` | `^1.3.0` | superseded |
| `0.3.0-alpha.x` | `^0.5.0-alpha.1` | `^1.3.0` | superseded |
| `0.2.0-alpha.x` | `^0.5.0-alpha.1` | `^1.3.0` | superseded |
| `0.1.0-alpha.x` | `^0.5.0-alpha.1` | `^1.3.0` | superseded |

`0.5.3` widens the `darwin-agents` peer to `>=0.5.0-alpha.1 <0.11.0` — the old
`<0.8.0` cap made a fresh `npm install darwin-langgraph darwin-agents` fail
with an `ERESOLVE` conflict once `darwin-agents@0.9` became `latest`. The
adapter is verified against `@langchain/langgraph@1.4.4` and against
`darwin-agents` 0.9 and 0.10 (the re-exported trajectory types —
`ExecutionTrace` et al. — are unchanged across darwin-agents 0.5 → 0.10, so
the adapter contract is stable).

## V0.3 — observability + safety (LIVE this release)

V0.3 closes the three deferred items from V0.2's R2 review. Backwards
compatible — no consumer code changes required.

### Parent-run propagation on `DarwinTrajectoryEvent`

`DarwinCallbackHandler` now populates two new fields on every emitted
event:

- **`runId: string`** — the LangChain runId of the node-chain that
  produced the trajectory. Stable identifier suitable for correlation
  with OTEL spans, Langfuse traces, LangSmith runs.
- **`parentRunId?: string`** — the runId of the chain that invoked
  this node-chain. Omitted for top-level invokes. Use it to build the
  full span hierarchy in OTEL exporters.

```ts
const handler = new DarwinCallbackHandler({
  nodeMap: { research: "researcher" },
  onTrajectory: (event) => {
    const attrs = toOtelAttributes(event.trajectory);
    const span = tracer.startSpan(event.nodeName, {
      attributes: { ...attrs, "darwin.run.id": event.runId },
    });
    // event.parentRunId can be used as the parent context for span linking
    span.end();
  },
});
```

`withDarwinEvolution` legacy events do NOT carry the runId fields (no
runId exists in the monkey-patch path). Migrate to
`DarwinCallbackHandler` if you need them.

### Double-wrap warning on `withDarwinEvolution`

A `Symbol.for("darwin-langgraph.evolution.wrapped")` sentinel is now
stamped on each wrapped graph. A second `withDarwinEvolution(graph, …)`
call on the same graph instance emits a one-shot `console.warn`:

```
[darwin-langgraph] withDarwinEvolution(): graph appears to be wrapped twice
  — both hooks will fire per run, producing duplicate trajectories.
```

Some users legitimately layer multiple `nodeMap` slices on one graph,
so the wrap still succeeds — but the silent-double-fire footgun is now
visible in logs. To layer cleanly, prefer multiple
`DarwinCallbackHandler` instances via `callbacks: [h1, h2]`.

### Hung-invoke guard on `DarwinCallbackHandler`

New option `maxInFlightRuns?: number` on
`DarwinCallbackHandlerOptions`. Caps the internal `runId → InFlightRun`
map at the configured size. When the cap is exceeded, the oldest
entry is evicted (Map insertion order) and a one-shot warning fires.
Defaults to **1024** — large enough for typical fan-out, small enough
to surface a real leak within minutes of an incident.

```ts
const handler = new DarwinCallbackHandler({
  nodeMap: { research: "researcher" },
  onTrajectory: (event) => { /* ... */ },
  maxInFlightRuns: 500,  // tighter for memory-constrained workers
});
```

Set `maxInFlightRuns: Infinity` to opt out (discouraged in production).

This defends against the failure mode where `handleChainEnd` /
`handleChainError` never fires (LangGraph internal bug, OS-level kill
of the worker mid-invoke, parent invoke aborted mid-flight). Without
the cap, the map grows without bound and leaks memory in long-running
processes (server singletons, schedulers, Temporal Workers).

### V0.2 — new surfaces (still LIVE)

V0.2 ships the three items from the V0.1 V0.2-roadmap, plus runtime
deprecation warnings on the legacy wrapper:

- **`DarwinCallbackHandler`** — LangChain-native replacement for
  `withDarwinEvolution`. Pass it via `graph.invoke(input, { callbacks:
  [new DarwinCallbackHandler({ nodeMap, onTrajectory }) ] })`. No more
  monkey-patching `invoke`/`stream`, no more `Set<symbol>` race-fix,
  no more `streamMode` gymnastics. Works identically with `invoke`,
  `stream` (any `streamMode`), and `streamEvents` because LangChain's
  callback mechanism fires regardless of how the consumer iterates.
- **`toOtelAttributes(trajectory, opts?)` + `toolCallToOtelAttributes(call, opts?)`** —
  pure mappers from Darwin's `ExecutionTrace` to flat
  `Record<string, string|number|boolean>` keyed by
  [OpenTelemetry GenAI Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
  (`gen_ai.operation.name`, `gen_ai.usage.input_tokens`, etc.) plus
  Darwin-namespaced custom attrs. Drop straight into Langfuse,
  Braintrust, Honeycomb, Datadog. Sensitive `arguments` / `result`
  fields are opt-in per OTEL spec.
- **`darwinMessagesAnnotation(extra?)`** — variant of `darwinAnnotation`
  that also includes LangGraph's canonical `messages` channel
  (`messagesStateReducer`). Use it when your graph mixes Darwin agents
  with `createReactAgent` / `MessagesAnnotation`-based prebuilt agents.
- **Runtime deprecation warning on `withDarwinEvolution`** — fires once
  per process on first call. The function still works identically for
  back-compat; it will be removed in v1.0. Migrate to
  `DarwinCallbackHandler`.

## Migration from v0.1.x to v0.2.x

Two lines:

```diff
- import { withDarwinEvolution } from "darwin-langgraph";
+ import { DarwinCallbackHandler } from "darwin-langgraph";
- const graph = withDarwinEvolution(compiledGraph, { nodeMap, onTrajectory });
- const result = await graph.invoke(input);
+ const handler = new DarwinCallbackHandler({ nodeMap, onTrajectory });
+ const result = await compiledGraph.invoke(input, { callbacks: [handler] });
```

`DarwinEvolutionOptions`, `DarwinNodeMapEntry`, and the
`DarwinTrajectoryEvent` shape passed to `onTrajectory` are 100% identical
between both APIs — no other code changes required.

## Migration from v0.2.x to v0.3.x

**No code changes required.** V0.3 is purely additive:

- `event.runId` and `event.parentRunId` are new optional fields — existing
  callbacks that don't read them keep working untouched.
- The double-wrap warning only fires if you actually double-wrap (most
  users do not).
- The default `maxInFlightRuns: 1024` is invisible in normal use. Override
  only if you have memory pressure or want to opt out via `Infinity`.

The adapter releases follow `darwin-agents` major bumps. When
`@langchain/langgraph` 2.x lands, the adapter ships a new major within
the same minor of the underlying Darwin release.

## Subscription / API key handling

The adapter NEVER touches `ANTHROPIC_API_KEY`. If you run Darwin on a
Claude Max subscription via the Claude Code CLI, your bootstrap must
`delete process.env.ANTHROPIC_API_KEY` BEFORE invoking the graph —
otherwise Darwin's `ClaudeCliProvider` will hit the metered API and you
pay per request instead of the flat subscription.

```ts
// bootstrap.ts
import "dotenv/config";
delete process.env.ANTHROPIC_API_KEY; // enforce Max-Plan subscription
```

## Design notes

- **Zero runtime deps.** Both `darwin-agents` and `@langchain/langgraph`
  are peer-dependencies. The adapter itself is a couple of hundred lines
  of TypeScript that re-exports a handful of types.
- **`invoke()` calls `stream()` internally.** LangGraph v1.x implements
  `invoke` on top of `stream`. The adapter tracks in-flight invokes
  with a per-call `Symbol` marker stored in a `Set` so the trajectory
  hook fires exactly once per logical run, even under concurrent
  `Promise.all([graph.invoke(...), graph.invoke(...)])`.
- **`GraphInterrupt` re-throw.** The adapter imports `isGraphInterrupt`
  directly from `@langchain/langgraph` so LangGraph's HITL exceptions
  (both `GraphInterrupt` and `NodeInterrupt`) propagate untouched —
  `Command({ resume })` works as expected.
- **Hook errors never propagate.** Both `opts.onResult` (on
  `createDarwinNode`) and `opts.onTrajectory` (on `withDarwinEvolution`)
  use a fire-and-forget pattern with one-shot `console.warn` for the
  first swallowed throw per process.
- **No memory provider construction.** Memory backends (Postgres,
  SQLite) are resolved by `darwin-agents` itself — set
  `DARWIN_POSTGRES_URL` / `DARWIN_SQLITE_PATH` env vars or pass
  `runOptions.config.dataDir`.

## Versioning

`darwin-langgraph@0.5.3` is the current **stable** release on the
`latest` dist-tag — `npm install darwin-langgraph` resolves to it (no
`@alpha` needed). The adapter tracks `darwin-agents` and is verified
against the latest `@langchain/langgraph` 1.x — see the compatibility
matrix above. When `@langchain/langgraph` 2.x lands, the adapter ships a
new major within the same minor of the underlying Darwin release.

```bash
npm install darwin-langgraph @langchain/langgraph darwin-agents
```

## Credits

Like [`darwin-agents`](https://github.com/studiomeyer-io/darwin-agents), this
adapter is pair-built: Matthias Meyer (StudioMeyer) directs and reviews, and
most of the code is written by [Claude](https://www.anthropic.com/claude) —
currently **Claude Fable 5** — verified against the live LangGraph.js docs and
this repo's test suite before release. Claude is listed as a contributor in
`package.json`; the commits it co-writes carry a `Co-Authored-By` trailer.

## License

MIT © 2026 StudioMeyer
