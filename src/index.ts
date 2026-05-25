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
export {
  DarwinCallbackHandler,
  type DarwinCallbackHandlerOptions,
} from "./darwin-callback-handler.js";

// V0.2 — OTEL GenAI Semantic Conventions mapping
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

export { DarwinNodeError, DarwinEvolutionHookError } from "./errors.js";

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
export const VERSION = "0.3.0-alpha.1";
