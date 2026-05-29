/**
 * Surface 9 (V0.4) — `darwinAccumulatingAnnotation(extra?)`.
 *
 * Variant of {@link darwinAnnotation} that REPLACES the singleton
 * `darwinTrajectory: ExecutionTrace | undefined` channel with an
 * accumulating `darwinTrajectories: ExecutionTrace[]` channel — every
 * node write appends, the channel never overwrites.
 *
 * Use this when you orchestrate multiple Darwin nodes in a single graph
 * (fan-out, sequential pipeline, supervisor pattern) and want ALL
 * trajectories preserved in graph state for end-of-run analysis without
 * having to declare a separate `*Trace` channel per node manually.
 *
 * The matching `trajectoryKey` you pass to each `createDarwinNode(...)`
 * call is `"darwinTrajectories"`. The reducer accepts EITHER a single
 * `ExecutionTrace` (matching the bare {@link createDarwinNode} contract)
 * OR an `ExecutionTrace[]` (lets advanced users batch-append from a
 * worker). Both paths flatten into the same accumulator array.
 *
 * @example
 * ```ts
 * import {
 *   createDarwinNode,
 *   darwinAccumulatingAnnotation,
 * } from "darwin-langgraph";
 * import { StateGraph } from "@langchain/langgraph";
 *
 * const State = darwinAccumulatingAnnotation();
 *
 * const graph = new StateGraph(State)
 *   .addNode("research", createDarwinNode(researcher, {
 *     trajectoryKey: "darwinTrajectories",
 *   }))
 *   .addNode("critique", createDarwinNode(critic, {
 *     trajectoryKey: "darwinTrajectories",
 *     taskKey: "output",
 *   }))
 *   .addEdge("__start__", "research")
 *   .addEdge("research", "critique")
 *   .compile();
 *
 * const result = await graph.invoke({ task: "What is GEPA?" });
 * console.log(`captured ${result.darwinTrajectories.length} trajectories`);
 * // → captured 2 trajectories
 * ```
 *
 * NEW V0.4 (S1235).
 */

import { Annotation } from "@langchain/langgraph";
import type { ExecutionTrace } from "darwin-agents";

import { getDarwinChannelSpec } from "./darwin-annotation.js";

/**
 * Tolerant accumulator reducer — accepts either a single
 * `ExecutionTrace` (the shape `createDarwinNode` actually emits) or an
 * `ExecutionTrace[]` (lets advanced users batch-append from a worker
 * graph). Both paths flatten into the previous array.
 *
 * Pure, exported for testability and so advanced users can hand-roll
 * their own `Annotation.Root` with the same semantics.
 */
export function darwinTrajectoryAccumulatorReducer(
  prev: ExecutionTrace[] | undefined,
  next: ExecutionTrace | ExecutionTrace[] | undefined,
): ExecutionTrace[] {
  const base = prev ?? [];
  if (next === undefined || next === null) return base;
  // R1 P0-2 fix (S1235): forward-compat — match `isExecutionTrace` and
  // accept `version >= 1` rather than strict `=== 1`. The mismatch let
  // v=2 trajectories through the DarwinCallbackHandler.onTrajectory
  // hook but silently dropped them on the accumulator side.
  const isTrace = (t: unknown): t is ExecutionTrace => {
    if (!t || typeof t !== "object") return false;
    const v = (t as { version?: unknown }).version;
    return typeof v === "number" && Number.isFinite(v) && v >= 1;
  };

  if (Array.isArray(next)) {
    const valid = next.filter(isTrace);
    if (valid.length === 0) return base;
    return [...base, ...valid];
  }
  if (!isTrace(next)) return base;
  return [...base, next];
}

/**
 * Reserved channel keys the accumulating annotation owns. Used by
 * {@link darwinAccumulatingAnnotation} to fail loud when an `extra`
 * spread would silently overwrite a Darwin-managed channel.
 *
 * NEW V0.4 (R1 P2-2 fix, S1235).
 */
const DARWIN_ACCUMULATING_RESERVED_KEYS = new Set([
  "task",
  "output",
  "darwinTrajectories",
]);

/**
 * Channel spec for the accumulating trajectory variant — re-exported for
 * power-users who want to spread it into their own `Annotation.Root`
 * call manually. Mirrors the {@link getDarwinChannelSpec} pattern.
 *
 * NEW V0.4 (S1235).
 */
export function getDarwinAccumulatingChannelSpec() {
  // Take task + output from the base spec but DROP the singleton
  // darwinTrajectory channel — callers using this annotation want the
  // accumulator under the plural key.
  const base = getDarwinChannelSpec();
  // Surgical: pluck task + output, drop darwinTrajectory.
  const { task, output } = base;
  return {
    task,
    output,
    darwinTrajectories: Annotation<ExecutionTrace[]>({
      reducer: darwinTrajectoryAccumulatorReducer,
      default: () => [],
    }),
  };
}

/**
 * Build an `Annotation.Root` with `task` + `output` + accumulating
 * `darwinTrajectories: ExecutionTrace[]` plus any extra channels.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function darwinAccumulatingAnnotation<Extra extends Record<string, any> = {}>(
  extra?: Extra,
) {
  // R1 P2-2 fix (S1235): fail loud if `extra` would silently overwrite
  // a Darwin-managed channel. Before this guard a caller passing
  // `extra = { darwinTrajectories: customAnnotation }` silently replaced
  // the accumulator and broke the contract advertised by the function
  // name without a single warning.
  if (extra) {
    for (const key of Object.keys(extra)) {
      if (DARWIN_ACCUMULATING_RESERVED_KEYS.has(key)) {
        throw new Error(
          `darwinAccumulatingAnnotation: "extra" cannot redefine the ` +
            `Darwin-managed channel "${key}". Reserved keys: ` +
            `${[...DARWIN_ACCUMULATING_RESERVED_KEYS].join(", ")}.`,
        );
      }
    }
  }
  return Annotation.Root({
    ...getDarwinAccumulatingChannelSpec(),
    ...(extra ?? ({} as Extra)),
  });
}
