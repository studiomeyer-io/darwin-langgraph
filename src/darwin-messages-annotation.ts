/**
 * Surface 6 (V0.2) — `darwinMessagesAnnotation(extra?)`.
 *
 * Variant of {@link darwinAnnotation} that also includes LangGraph's
 * canonical `messages` channel (using `messagesStateReducer` from
 * `@langchain/langgraph`). Use this when your graph mixes Darwin agents
 * with `createReactAgent` / `MessagesAnnotation`-based prebuilt agents
 * — they all read and write the same `messages` channel without
 * channel-name conflicts.
 *
 * Layered channels:
 *   - `task` (string, last-write-wins) — Darwin agent task input
 *   - `output` (string, last-write-wins) — Darwin agent text output
 *   - `darwinTrajectory` (ExecutionTrace | undefined) — captured trace
 *   - `messages` (BaseMessage[], `messagesStateReducer`) — chat history
 *
 * Composable: any `extra` channels merge in.
 *
 * @example
 * ```ts
 * import { darwinMessagesAnnotation, createDarwinNode } from "darwin-langgraph";
 * import { StateGraph } from "@langchain/langgraph";
 * import { createReactAgent } from "@langchain/langgraph/prebuilt";
 * import { ChatAnthropic } from "@langchain/anthropic";
 *
 * const State = darwinMessagesAnnotation();
 *
 * const planner = createReactAgent({
 *   llm: new ChatAnthropic({ model: "claude-haiku-4-5" }),
 *   tools: [],
 * });
 *
 * const graph = new StateGraph(State)
 *   .addNode("plan", planner)                        // writes to messages
 *   .addNode("execute", createDarwinNode(myAgent))   // writes to output
 *   .addEdge("__start__", "plan")
 *   .addEdge("plan", "execute")
 *   .compile();
 * ```
 *
 * Design notes:
 *   - **Same inference quirk as `darwinAnnotation`.** Return type is
 *     inferred from `Annotation.Root`; the internal `LastValue` vs
 *     `BaseChannel` union is opaque to it. Hand-typing triggers TS2741.
 *   - **`messages` default is `[]`** — graphs that don't seed messages
 *     in `invoke({ task: "..." })` still work.
 */

import {
  Annotation,
  messagesStateReducer,
} from "@langchain/langgraph";
import type { BaseMessage } from "@langchain/core/messages";

import { getDarwinChannelSpec } from "./darwin-annotation.js";

/**
 * Spec for the `messages` channel — re-exported for power-users who want
 * to spread it into their own `Annotation.Root` call manually.
 *
 * Return type inferred (same `LastValue<T>` vs `BaseChannel<T>` quirk
 * documented on `getDarwinChannelSpec` — hand-typing triggers TS2741).
 */
export function getMessagesChannelSpec() {
  return {
    messages: Annotation<BaseMessage[]>({
      reducer: messagesStateReducer,
      default: () => [],
    }),
  };
}

/**
 * Build an `Annotation.Root` with the three Darwin channels PLUS the
 * canonical `messages` channel for interop with `createReactAgent` /
 * `MessagesAnnotation`-based prebuilt agents.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function darwinMessagesAnnotation<Extra extends Record<string, any> = {}>(
  extra?: Extra,
) {
  return Annotation.Root({
    ...getDarwinChannelSpec(),
    ...getMessagesChannelSpec(),
    ...(extra ?? ({} as Extra)),
  });
}
