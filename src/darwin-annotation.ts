/**
 * Surface 2 — `darwinAnnotation(extra?)`.
 *
 * Returns a LangGraph `Annotation.Root({ ... })` pre-populated with three
 * Darwin-aware channels:
 *   - `task` (string, last-write-wins): the task fed to the Darwin agent.
 *   - `output` (string, last-write-wins): the agent's final text output.
 *   - `darwinTrajectory` (ExecutionTrace | undefined, last-write-wins):
 *     the captured execution trace, available downstream nodes or to
 *     the post-run evolution hook.
 *
 * Composable: pass any extra channels via the `extra` argument and they
 * merge into the same `Annotation.Root` spread.
 *
 * @example
 * ```ts
 * import { darwinAnnotation } from "darwin-langgraph";
 * import { Annotation, StateGraph } from "@langchain/langgraph";
 *
 * const State = darwinAnnotation({
 *   reviewNotes: Annotation<string[]>({
 *     reducer: (a, b) => a.concat(b),
 *     default: () => [],
 *   }),
 * });
 *
 * const graph = new StateGraph(State)
 *   .addNode("research", createDarwinNode(researcher))
 *   .addNode("review", createDarwinNode(reviewer))
 *   .compile();
 * ```
 *
 * Design note: the channels use default last-write-wins reducers. If you
 * want trajectory-accumulation (e.g. one entry per node), define your own
 * channel via `extra` (e.g. `trajectories: Annotation<ExecutionTrace[]>(...)`)
 * and skip `captureTrace` on every `createDarwinNode` call except the one
 * you want to overwrite the singleton.
 */

import { Annotation } from "@langchain/langgraph";
import type { ExecutionTrace } from "darwin-agents";

/**
 * Pure last-write-wins reducer for trajectory. Exported for testability
 * and so consumers can wrap it (e.g. cap at last-N).
 */
export function lastWriteWinsTrajectoryReducer(
  _prev: ExecutionTrace | undefined,
  next: ExecutionTrace | undefined,
): ExecutionTrace | undefined {
  return next;
}

/**
 * Spec object used inside `Annotation.Root({ ... })`. Exported so power
 * users can spread it manually into their own `Annotation.Root` call when
 * the generic helper doesn't fit their setup (e.g. when they need a
 * differently named `task` or `output` channel and don't want the
 * defaults).
 *
 * Returned as a fresh object on every call so consumers can mutate it
 * without affecting other graphs in the same process — the underlying
 * `Annotation<T>` references are reused, which is what LangGraph expects.
 *
 * Return type is intentionally inferred. The internal `LastValue<T>` vs
 * `BaseChannel<...>` mismatch between `Annotation<T>()` (zero-arg, plain
 * last-write) and `Annotation<T>({reducer,default})` (full BaseChannel)
 * is opaque to `Annotation.Root` (it accepts the union via `SDZod`).
 * Hand-typing the return triggers TS2741 — inference works correctly.
 */
export function getDarwinChannelSpec() {
  return {
    task: Annotation<string>(),
    output: Annotation<string>(),
    darwinTrajectory: Annotation<ExecutionTrace | undefined>({
      reducer: lastWriteWinsTrajectoryReducer,
      default: () => undefined,
    }),
  };
}

/**
 * Build an `Annotation.Root` schema with Darwin's three default channels
 * plus any extra channels supplied by the caller.
 *
 * The return type is intentionally inferred from
 * `Annotation.Root({...})` so `typeof darwinAnnotation().State` works
 * exactly like a hand-rolled `Annotation.Root`.
 */
// Wide return type because `Annotation.Root` returns a complex inferred
// generic that depends on the precise channel spec. Consumers extract
// `typeof X.State` so the concrete shape is recovered at the use site.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function darwinAnnotation<Extra extends Record<string, any> = {}>(
  extra?: Extra,
) {
  return Annotation.Root({
    ...getDarwinChannelSpec(),
    ...(extra ?? ({} as Extra)),
  });
}
