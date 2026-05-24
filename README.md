# darwin-langgraph

> **LangGraph.js adapter for [`darwin-agents`](https://www.npmjs.com/package/darwin-agents).**
> Wrap self-evolving Darwin agents as `StateGraph` nodes — with zero hard deps.

[![npm version](https://img.shields.io/npm/v/darwin-langgraph/alpha.svg)](https://www.npmjs.com/package/darwin-langgraph)
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
npm install darwin-langgraph@alpha @langchain/langgraph darwin-agents@alpha
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

## Three surfaces

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
| `runOptions` | object | `{}` | Passthrough for `model`, `maxTurns`, `timeout`, `cwd`, `autonomous`, `config`. |
| `captureTrace` | `boolean` | `true` | Set `false` to skip trajectory propagation. |
| `onResult` | function | — | Fire-and-forget side-effect after each run. Errors are swallowed. |

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
| `0.2.0-alpha.x` | `^0.5.0-alpha.1` | `^1.3.0` | alpha (this release) |
| `0.1.0-alpha.x` | `^0.5.0-alpha.1` | `^1.3.0` | superseded |

The peer-dep range `darwin-agents: "^0.5.0-alpha.1"` follows npm's
prerelease semver rules — `0.5.0-alpha.N` and `0.5.0` final satisfy it,
but `0.5.1-alpha.0` does NOT. A patch release of this adapter will be
required when `darwin-agents` bumps past `0.5.x`.

## V0.2 — new surfaces (LIVE this release)

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

Released under the `alpha` npm dist-tag in parallel with
`darwin-agents@0.5.0-alpha.1`. Because `0.1.0-alpha.1` is the FIRST
publish, npm assigns BOTH `alpha` and `latest` to it (npm rule: a
package must always have a `latest` tag) — so `npm install
darwin-langgraph` and `npm install darwin-langgraph@alpha` resolve to
the same version right now. Once `0.1.0` final ships, `latest` will
point to the stable release and `alpha` will continue to track
pre-releases.

For maximum clarity in alpha-stage projects, prefer the explicit
opt-in form:

```bash
npm install darwin-langgraph@alpha @langchain/langgraph darwin-agents@alpha
```

## License

MIT © 2026 StudioMeyer
