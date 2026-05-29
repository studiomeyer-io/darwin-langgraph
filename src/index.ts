/**
 * darwin-langgraph — LangGraph.js adapter for darwin-agents.
 *
 * Public entry. Three surfaces + types + errors.
 *
 * @example
 * ```ts
 * import { StateGraph } from "@langchain/langgraph";
 * import { defineAgent } from "darwin-agents";
 * import {
 *   createDarwinNode,
 *   darwinAnnotation,
 *   withDarwinEvolution,
 * } from "darwin-langgraph";
 *
 * const researcher = defineAgent({
 *   name: "researcher",
 *   role: "Topic Researcher",
 *   description: "Five bullets on a topic.",
 *   systemPrompt: "Return exactly 5 bullet points.",
 * });
 *
 * const graph = withDarwinEvolution(
 *   new StateGraph(darwinAnnotation())
 *     .addNode("research", createDarwinNode(researcher))
 *     .addEdge("__start__", "research")
 *     .compile(),
 *   {
 *     nodeMap: { research: "researcher" },
 *     onTrajectory: (event) => {
 *       console.log(`${event.nodeName} (${event.agentName}) trajectory:`, event.trajectory);
 *     },
 *   },
 * );
 *
 * const result = await graph.invoke({ task: "What is GEPA?" });
 * console.log(result.output);
 * ```
 */

export {
  createDarwinNode,
  type CreateDarwinNodeOptions,
  type DarwinNodeFn,
  type DarwinRunOptionsPassthrough,
} from "./create-darwin-node.js";

export {
  darwinAnnotation,
  getDarwinChannelSpec,
  lastWriteWinsTrajectoryReducer,
} from "./darwin-annotation.js";

export {
  withDarwinEvolution,
  type DarwinEvolutionOptions,
  type DarwinNodeMapEntry,
  type DarwinTrajectoryEvent,
} from "./with-darwin-evolution.js";

// V0.2 — LangChain-native callback handler (preferred over `withDarwinEvolution`)
// V0.4 — extended with onToolEvent + maxTrajectoryBytes + MAX_KNOWN_TRACE_VERSION
export {
  DarwinCallbackHandler,
  MAX_KNOWN_TRACE_VERSION,
  type DarwinCallbackHandlerOptions,
  type DarwinToolEvent,
} from "./darwin-callback-handler.js";

// V0.2 — OTEL GenAI Semantic Conventions mapping
// V0.4 — extended with langGraphNode / langGraphStep / userId / requestId
export {
  toOtelAttributes,
  toolCallToOtelAttributes,
  type OtelAttributes,
  type ToOtelAttributesOptions,
  type ToolCallOtelOptions,
} from "./to-otel-attributes.js";

// V0.2 — MessagesAnnotation interop for graphs mixing createReactAgent + createDarwinNode
export {
  darwinMessagesAnnotation,
  getMessagesChannelSpec,
} from "./darwin-messages-annotation.js";

// V0.4 — accumulating annotation for graphs that fan-out multiple Darwin nodes
export {
  darwinAccumulatingAnnotation,
  getDarwinAccumulatingChannelSpec,
  darwinTrajectoryAccumulatorReducer,
} from "./darwin-accumulating-annotation.js";

// V0.4 — token-budget callbacks (production guard against runaway agents)
export {
  TokenBudgetCallbackHandler,
  createTokenBudgetCallbacks,
  type TokenBudgetOptions,
  type TokenBudgetExceedInfo,
  type TokenBudgetTickInfo,
} from "./token-budget.js";

// V0.4 — W3C Trace Context mapper for cross-process span correlation
export {
  toW3CTraceContext,
  type ToW3CTraceContextOptions,
  type W3CTraceContext,
} from "./to-w3c-trace-context.js";

// V0.4 — createDarwinNode runtime info passthrough
export type { DarwinNodeAttemptInfo } from "./create-darwin-node.js";

export {
  DarwinNodeError,
  DarwinEvolutionHookError,
  DarwinTokenBudgetExceededError,
} from "./errors.js";

export type {
  AgentDefinition,
  DarwinExperiment,
  ExecutionTrace,
  MemoryProvider,
  RunResult,
  TraceToolCall,
  TraceTokenUsage,
  TraceTurnError,
} from "./types.js";

/** Adapter version — sync with `package.json` on every release. */
export const VERSION = "0.4.0-alpha.1";
