# StudioMeyer Ecosystem

`darwin-langgraph` is part of the StudioMeyer open source toolkit. This file maps where it sits,
what it pairs well with, and what sibling repos exist if your problem isn't a Darwin-into-LangGraph
adapter problem.

## Where this repo sits

This is an **adapter package** — the bridge between
[`darwin-agents`](https://github.com/studiomeyer-io/darwin-agents) (self-evolving AI agents
with A/B testing + GEPA reflective optimisation + trajectory capture) and
[`@langchain/langgraph`](https://github.com/langchain-ai/langgraphjs) (low-level stateful
agent-workflow orchestration). Both upstream packages are peer-dependencies. The adapter ships
zero hard runtime deps.

If you want to **run Darwin agents as LangGraph nodes** — wire them into a `StateGraph`, capture
trajectories per-node, route them to OTEL / Langfuse / LangSmith, mix them with LangChain's
`createReactAgent` prebuilt — that's exactly what this adapter is for.

If you don't need LangGraph orchestration (you just want to call Darwin agents directly), skip
this adapter and use `darwin-agents` standalone. The adapter is a thin layer; you pay nothing by
skipping it when you don't need it.

## What the adapter actually does

Six public surfaces, one peer-dep contract:

| Surface | Since | Job |
|---------|-------|-----|
| `createDarwinNode(agent, opts?)` | V0.1 | Wrap a Darwin `AgentDefinition` as a LangGraph `NodeAction`. |
| `darwinAnnotation(extra?)` | V0.1 | Pre-built `Annotation.Root({ task, output, darwinTrajectory, ...extra })`. |
| `withDarwinEvolution(graph, opts)` | V0.1 (@deprecated since V0.2) | Monkey-patch `invoke` / `stream` with a post-run hook. Legacy. |
| `DarwinCallbackHandler` | V0.2 | LangChain-native `BaseCallbackHandler` — preferred over `withDarwinEvolution`. |
| `toOtelAttributes(trajectory, opts?)` | V0.2 | Pure mapper to OpenTelemetry GenAI Semantic Conventions. |
| `darwinMessagesAnnotation(extra?)` | V0.2 | Annotation variant with `messagesStateReducer` channel — for `createReactAgent` interop. |

V0.3 added: `runId` + `parentRunId` propagation on `DarwinTrajectoryEvent` (for OTEL / Langfuse
span hierarchies), double-wrap warning on `withDarwinEvolution`, and a configurable
`maxInFlightRuns` cap on `DarwinCallbackHandler` to defend against hung-invoke leaks.

## MCP Server Products (Hosted)

| Product | Tools | What it does | Link |
|---------|-------|-------------|------|
| **StudioMeyer Memory** | 56 | Persistent AI memory with knowledge graph, semantic search, multi-agent support, 3D visualizations | [memory.studiomeyer.io](https://memory.studiomeyer.io) |
| **StudioMeyer CRM** | 33 | Headless CRM (contacts, companies, deals, pipeline, health scores, Stripe sync) | [crm.studiomeyer.io](https://crm.studiomeyer.io) |
| **StudioMeyer GEO** | 24 | AI visibility monitoring across 8 LLM platforms | [geo.studiomeyer.io](https://geo.studiomeyer.io) |
| **MCP Crew** | 10 | 8 expert personas with domain frameworks | [crew.studiomeyer.io](https://crew.studiomeyer.io) |

All MCP products use OAuth 2.1 + Magic Link authentication. Free tiers available. EU Frankfurt
hosting.

### Why the adapter pairs especially well with StudioMeyer Memory

Darwin agents in `darwin-agents` can be given a `MemoryProvider` for persistent state. The
production provider is the StudioMeyer Memory REST API. When you wire a Darwin agent into a
LangGraph node via `createDarwinNode`, every memory `search` / `learn` / `decide` call inside
the agent run goes to Memory — the same way it would in a standalone Darwin run. The adapter
adds nothing on this axis. The trajectory you receive in `onTrajectory` lists the memory
operations as tool calls, ready to forward to OTEL via `toOtelAttributes`.

**BYO or hosted:** point `NEX_MEMORY_URL` at `memory.studiomeyer.io` for the SaaS, or at any
compatible REST endpoint (your own deployment of the Memory protocol).

## Sibling Repos (the full stack)

| Project | Description | Install |
|---------|-------------|---------|
| **[darwin-agents](https://github.com/studiomeyer-io/darwin-agents)** | Self-evolving agent framework with A/B testing, GEPA reflective optimisation, trajectory capture, OTEL-mapbar schema. **Required peer-dep of this adapter.** | `npm install darwin-agents@alpha` |
| **[@langchain/langgraph](https://github.com/langchain-ai/langgraphjs)** | Low-level state-graph workflow orchestration for LLM agents. Durable, checkpointed, interrupt-friendly. **Required peer-dep of this adapter.** | `npm install @langchain/langgraph` |
| **[temporal-memory-workflows](https://github.com/studiomeyer-io/temporal-memory-workflows)** | Sister repo for **durable workflow execution** via [Temporal](https://temporal.io). 5 templates (T01-T05) covering memory-aware agents, saga rollback, scheduled synthesis. Use when you need crash-resume / multi-day workflows / signal-based human approval. | clone + `npm install` |
| **[@studiomeyer/local-memory-mcp](https://github.com/studiomeyer-io/local-memory-mcp)** | Self-hosted SQLite-backed Memory MCP. Same interface as the hosted Memory product — swap in via `MemoryProvider` for solo-dev, zero-cloud Darwin runs. | `npm install local-memory-mcp` |
| **[n8n-nodes-studiomeyer-memory](https://github.com/studiomeyer-io/n8n-nodes-studiomeyer-memory)** | Official n8n community node for StudioMeyer Memory. Useful when you want a visual workflow that touches the same memory state as your Darwin / LangGraph code. | `npm install n8n-nodes-studiomeyer-memory` |
| **[mcp-personal-suite](https://github.com/studiomeyer-io/mcp-personal-suite)** | 49 personal-productivity MCP tools (mail, calendar, files, tasks, notes). Not directly related to LangGraph — shares brand and Memory-first design. | `npx mcp-personal-suite` |
| **[mcp-armor](https://github.com/studiomeyer-io/mcp-armor)** | Defensive security sidecar that transparently wraps stdio MCP servers (prompt-injection scanner, Ed25519 manifest verify, CVE blocklist). Pair with Memory or Personal Suite when you connect untrusted MCP servers from inside Darwin tool calls. | Rust binary |
| **[agent-fleet](https://github.com/studiomeyer-io/agent-fleet)** | Multi-agent orchestration patterns for Claude Code CLI (parallel + stateful with crash-resume). Different layer — Agent Fleet manages CLI subprocesses; LangGraph manages stateful graphs. They compose. | clone + `npm install` |
| **[ai-shield](https://github.com/studiomeyer-io/ai-shield)** | LLM security middleware (prompt injection, PII, cost tracking, tool policies, audit logging). Wrap the Anthropic / OpenAI client your Darwin agent uses. | `npm install ai-shield-core` |

## When to use what

The orchestration-layer landscape has gotten crowded. Quick decision guide:

| Need | Use | Why |
|------|-----|-----|
| LLM-centric multi-step chain that pauses for human input mid-stream, runs in minutes | **LangGraph** + this adapter | State graph + human-in-the-loop primitives, optimised for LLM token budgets and tool-calling loops. The adapter adds Darwin's trajectory capture + evolution hook on top. |
| Visual deterministic pipeline a non-developer can edit, runs in seconds | **n8n** | Drag-and-drop nodes, hundreds of integrations, no code path to deploy. See [`n8n-nodes-studiomeyer-memory`](https://github.com/studiomeyer-io/n8n-nodes-studiomeyer-memory). |
| Cloudflare-native long-running workflow (Workers + R2 + D1 stack) | **Cloudflare Workflows** | Hibernation + steps API + Workers-runtime integration. Closed ecosystem but tight if you're already on CF. |
| Production saga with compensations, signal-based human approval that may wait days, child-workflow fan-out across worker fleets, weeks of waiting on external events with full audit trail | **Temporal** — see [`temporal-memory-workflows`](https://github.com/studiomeyer-io/temporal-memory-workflows) | Durable execution as a first-class primitive. Different problem space from in-process LangGraph state graphs. |
| Just call a Darwin agent, no orchestration needed | **`darwin-agents`** standalone | The adapter is overhead if you don't have a graph to wire into. Skip this repo. |

If your workflow is "wire one or more Darwin agents into a `StateGraph`, capture per-node
trajectories, surface them to OTEL / Langfuse / LangSmith, optionally mix with LangChain's
`createReactAgent`", this repo is the right starting point.

## How the surfaces typically compose

**Basic node integration:**

```ts
import { StateGraph } from "@langchain/langgraph";
import { defineAgent } from "darwin-agents";
import { createDarwinNode, darwinAnnotation } from "darwin-langgraph";

const researcher = defineAgent({ name: "researcher", systemPrompt: "..." });

const graph = new StateGraph(darwinAnnotation())
  .addNode("research", createDarwinNode(researcher))
  .addEdge("__start__", "research")
  .compile();

const result = await graph.invoke({ task: "What is GEPA?" });
```

**With trajectory capture (V0.2 LangChain-native pattern):**

```ts
import { DarwinCallbackHandler, toOtelAttributes } from "darwin-langgraph";

const handler = new DarwinCallbackHandler({
  nodeMap: { research: "researcher" },
  onTrajectory: (event) => {
    // V0.3: event.runId + event.parentRunId are populated
    const attrs = toOtelAttributes(event.trajectory);
    otelTracer.startSpan(event.nodeName, { attributes: attrs }).end();
  },
});

await graph.invoke({ task: "..." }, { callbacks: [handler] });
```

**With Temporal for crash-resume durability (cross-repo composition):**

The adapter package lives inside a Temporal activity in your `temporal-memory-workflows`
template. The activity calls `graph.invoke(...)` with `DarwinCallbackHandler` attached, the
handler writes trajectory data into `memory` inside the same activity. If the activity crashes
between the LangGraph call and the memory write, Temporal retries the activity from the start
— the workflow stays consistent because LangGraph's invoke is idempotent on the same input.

## Where the package fits

The flow we expect a builder to take:

1. They hit a Reddit post, dev.to article, or LinkedIn write-up about Darwin agents and LangGraph
   orchestration.
2. They clone the `darwin-agents` examples, get a feel for the standalone API.
3. They want to wire one of those agents into a `StateGraph` for a multi-step task.
4. They `npm install darwin-langgraph@alpha @langchain/langgraph darwin-agents@alpha`.
5. They paste the "Basic node integration" snippet above, swap in their agent, get a green run.
6. They add `DarwinCallbackHandler` to capture trajectories for evolution / observability.
7. They optionally add `toOtelAttributes` to push trace data to their existing observability
   stack (Langfuse, LangSmith, OTEL backend).

## License

Every project in this ecosystem ships under [MIT](LICENSE) unless explicitly stated otherwise.
Use them in commercial deployments without permission. Attribution appreciated but not required.

## Contact

- General: [hello@studiomeyer.io](mailto:hello@studiomeyer.io)
- Studio: [studiomeyer.io](https://studiomeyer.io)
- Built in Mallorca.
