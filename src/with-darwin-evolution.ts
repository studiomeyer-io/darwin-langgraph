/**
 * Surface 3 — `withDarwinEvolution(graph, opts)`.
 *
 * Wraps a compiled `StateGraph` with a fire-and-forget post-run hook
 * that mirrors Darwin's closed-loop evolution pattern (see
 * `agents/lib/darwin-hook.ts` for the in-tree Nex implementation):
 *
 *   1. After `graph.invoke(...)` resolves, we extract trajectories from
 *      the final state and dispatch them to `opts.onTrajectory` per
 *      mapped node.
 *   2. The same applies to `graph.stream(...)` — we wrap the async
 *      iterator and replay the final-state chunk to the hook once the
 *      consumer finishes iterating.
 *
 * Design notes (S1185):
 *   - **Never throws inside the hook.** Caller logic that fails inside
 *     `onTrajectory` is logged once per process and otherwise swallowed.
 *     The graph result the consumer sees is identical with or without
 *     the wrap.
 *   - **No mutation of `graph` if it doesn't expose `invoke`/`stream`
 *     as own properties.** We bind via `Object.defineProperty` and fall
 *     back to a no-op wrap if the graph is frozen. This means future
 *     LangGraph internals that move `invoke` to a hidden prototype slot
 *     won't crash — at worst, the hook silently never fires (the test
 *     suite catches that case).
 *   - **`nodeMap` shape:** either `string` (treated as
 *     `{ agentName: string, trajectoryKey: defaultKey }`) or an object
 *     with explicit `trajectoryKey`. Supports both ergonomic one-liner
 *     and per-node trajectory routing in the same graph.
 */

import type { ExecutionTrace } from "darwin-agents";

import { DarwinEvolutionHookError } from "./errors.js";

/** Map entry — either a bare agent name or an explicit `{agent, key}` tuple. */
export type DarwinNodeMapEntry =
  | string
  | { agentName: string; trajectoryKey: string };

/** Argument passed to {@link DarwinEvolutionOptions.onTrajectory}. */
export interface DarwinTrajectoryEvent {
  /** Name of the StateGraph node that produced the trajectory. */
  nodeName: string;
  /** Darwin agent name (from the `nodeMap` mapping). */
  agentName: string;
  /** The captured execution trace. */
  trajectory: ExecutionTrace;
  /**
   * Snapshot of the final graph state. The TOP-LEVEL object is frozen
   * (shallow), but NESTED objects (incl. the trajectory itself) are NOT
   * deep-frozen for performance — treat them as logically immutable by
   * convention. Mutating nested values leaks back into the live graph
   * state and corrupts subsequent runs (R1 Critic Finding 4, S1185).
   */
  finalState: Readonly<Record<string, unknown>>;
}

/** Options for {@link withDarwinEvolution}. */
export interface DarwinEvolutionOptions {
  /**
   * Maps StateGraph node names to either a bare Darwin agent name
   * (uses `darwinTrajectory` as the state key) or an object specifying
   * a custom `trajectoryKey` for that node.
   *
   * Example:
   * ```ts
   * nodeMap: {
   *   research: "researcher",
   *   review: { agentName: "critic", trajectoryKey: "criticTrajectory" },
   * }
   * ```
   */
  nodeMap: Record<string, DarwinNodeMapEntry>;
  /**
   * Called once per mapped node whose trajectory was found in the final
   * state. Errors are swallowed — never breaks the graph result.
   */
  onTrajectory?: (event: DarwinTrajectoryEvent) => void | Promise<void>;
  /** Default trajectory key when `nodeMap` entry is a bare string. Default: `"darwinTrajectory"`. */
  defaultTrajectoryKey?: string;
}

/** Minimal interface the adapter needs — covers `CompiledStateGraph`. */
interface InvokableGraph {
  invoke(input: unknown, config?: unknown): Promise<unknown>;
  stream(input: unknown, config?: unknown): Promise<AsyncIterable<unknown>>;
}

/**
 * Wraps a compiled LangGraph so the supplied `onTrajectory` callback
 * fires for each node listed in `nodeMap` after every `invoke` / `stream`
 * run. Returns the same graph instance for chaining.
 *
 * @throws {DarwinEvolutionHookError} when `nodeMap` is empty or missing.
 */
export function withDarwinEvolution<G extends InvokableGraph>(
  graph: G,
  opts: DarwinEvolutionOptions,
): G {
  if (!opts || !opts.nodeMap || Object.keys(opts.nodeMap).length === 0) {
    throw new DarwinEvolutionHookError(
      "withDarwinEvolution: opts.nodeMap is required and must contain at least one entry.",
    );
  }

  const defaultKey = opts.defaultTrajectoryKey ?? "darwinTrajectory";
  const callback = opts.onTrajectory;

  // Normalise nodeMap once. Each entry knows its trajectoryKey so the
  // hot path doesn't re-resolve defaults per invocation.
  const resolved = new Map<string, { agentName: string; trajectoryKey: string }>();
  for (const [nodeName, entry] of Object.entries(opts.nodeMap)) {
    if (typeof entry === "string") {
      resolved.set(nodeName, { agentName: entry, trajectoryKey: defaultKey });
    } else if (
      entry !== null &&
      typeof entry === "object" &&
      typeof entry.agentName === "string" &&
      typeof entry.trajectoryKey === "string"
    ) {
      resolved.set(nodeName, {
        agentName: entry.agentName,
        trajectoryKey: entry.trajectoryKey,
      });
    } else {
      throw new DarwinEvolutionHookError(
        `withDarwinEvolution: nodeMap entry for "${nodeName}" must be a string or ` +
          `{ agentName, trajectoryKey }, got ${typeof entry}.`,
      );
    }
  }

  let warned = false;
  const swallow = (err: unknown): void => {
    if (warned || !err) return;
    warned = true;
    console.warn(
      `[darwin-langgraph] onTrajectory callback threw — swallowed. ` +
        `Subsequent throws will be silent. Original error: ` +
        `${(err as Error)?.message ?? String(err)}`,
    );
  };

  const fireHook = async (finalState: unknown): Promise<void> => {
    if (!callback) return;
    if (finalState === null || typeof finalState !== "object") return;
    const stateObj = finalState as Record<string, unknown>;
    const frozen = Object.freeze({ ...stateObj });

    for (const [nodeName, { agentName, trajectoryKey }] of resolved) {
      const trajectory = stateObj[trajectoryKey] as ExecutionTrace | undefined;
      if (!trajectory || typeof trajectory !== "object" || trajectory.version !== 1) {
        continue;
      }
      try {
        await callback({
          nodeName,
          agentName,
          trajectory,
          finalState: frozen,
        });
      } catch (err) {
        swallow(err);
      }
    }
  };

  // Bind originals once. We keep references so consumer re-binds via
  // a second `withDarwinEvolution` call still work (the second wrap
  // chains on top of the first wrap's wrapped methods).
  const originalInvoke = graph.invoke.bind(graph);
  const originalStream = graph.stream.bind(graph);

  /**
   * `graph.invoke` is internally implemented on top of `graph.stream` in
   * `@langchain/langgraph@1.x`. If we naively wrap both, every `invoke`
   * call fires the hook TWICE — once from the wrapped stream that invoke
   * consumed, once from the wrapped invoke itself. We tag each in-flight
   * `invoke` with a unique `Symbol` stored in a `Set` and the wrapped
   * `stream` checks `set.size > 0` to know it was called from inside an
   * invoke (in which case the outer invoke handles the hook).
   *
   * R1 Critic Finding 1 fix (S1185): replaced the prior shared-counter
   * with a `Set<symbol>`. JS is single-threaded, so `Set.add` followed by
   * `Set.size` in another microtask cannot interleave at the byte level
   * — concurrent invokes both increment the set BEFORE either stream sees
   * `size > 0`, so both streams correctly suppress and both invokes
   * correctly fire the hook exactly once each. The prior `let
   * invokesInFlight = 0` had a race window where two concurrent invokes
   * could both read `0` and both fire from invoke AND stream.
   */
  const activeInvokeMarkers = new Set<symbol>();

  const wrappedInvoke = async (input: unknown, config?: unknown): Promise<unknown> => {
    const marker = Symbol("darwin-langgraph:invoke");
    activeInvokeMarkers.add(marker);
    try {
      const result = await originalInvoke(input, config);
      // Fire-and-forget — don't await the hook from the caller's perspective.
      void fireHook(result).catch(swallow);
      return result;
    } finally {
      activeInvokeMarkers.delete(marker);
    }
  };

  /**
   * R1 Critic Finding 2 fix (S1185): warn once if the consumer calls
   * `stream()` with a `streamMode` other than `"values"`. The hook is
   * shape-tolerant but for `"updates"` / `"messages"` modes the last
   * chunk is a node-update dict, NOT the final state — the trajectory
   * lookup silently misses. Users hit this constantly because
   * `streamMode: "updates"` is the implicit default.
   */
  let streamModeWarned = false;
  const warnStreamMode = (mode: unknown): void => {
    if (streamModeWarned) return;
    streamModeWarned = true;
    console.warn(
      `[darwin-langgraph] withDarwinEvolution: stream() called with streamMode=` +
        `${typeof mode === "string" ? `"${mode}"` : String(mode)}. ` +
        `The trajectory hook reliably fires only when streamMode="values" ` +
        `(default for invoke()). For "updates"/"messages"/multi-mode streams, ` +
        `the last chunk is not the final state and the hook may silently skip. ` +
        `Subsequent calls will be silent.`,
    );
  };

  const wrappedStream = async (
    input: unknown,
    config?: unknown,
  ): Promise<AsyncIterable<unknown>> => {
    // R2 Critic Finding R2-3: compute `suppressHook` BEFORE awaiting
    // `originalStream` to make the ordering guarantee explicit.
    //
    // Ordering invariant: `wrappedInvoke` calls `activeInvokeMarkers.add()`
    // SYNCHRONOUSLY before its `await originalInvoke()` yields. Inside
    // `originalInvoke`, LangGraph calls the UNWRAPPED `graph.stream`
    // (which our wrapper's `originalStream.bind(graph)` points to), so
    // this wrapper IS NOT re-entered from invoke's stream call. The only
    // way control reaches `wrappedStream` is via a direct user call to
    // `graph.stream()`. The Set check therefore correctly tells us:
    // "is some OTHER invoke currently in-flight?". If yes, this stream
    // is parallel work whose hook the invoke side will handle — suppress.
    // If no, this is a top-level stream call — fire the hook ourselves.
    const suppressHook = activeInvokeMarkers.size > 0;
    const iter = await originalStream(input, config);

    if (suppressHook) {
      return iter;
    }

    // R1 Critic Finding 2: warn if caller asked for a non-"values" stream
    // mode so the silent-skip case at least surfaces in logs.
    if (
      config !== null &&
      typeof config === "object" &&
      "streamMode" in (config as Record<string, unknown>)
    ) {
      const mode = (config as Record<string, unknown>).streamMode;
      if (mode !== "values" && !(Array.isArray(mode) && mode.includes("values"))) {
        warnStreamMode(mode);
      }
    }

    // Wrap the async iterator so we can capture the final chunk for the hook.
    let lastChunk: unknown = undefined;
    let hookFired = false;
    const fireOnce = (chunk: unknown): void => {
      if (hookFired) return;
      hookFired = true;
      void fireHook(chunk).catch(swallow);
    };

    const wrapped: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]() {
        const inner = iter[Symbol.asyncIterator]();
        return {
          async next() {
            const res = await inner.next();
            if (res.done) {
              // Fire hook with the last chunk we saw. For `streamMode: "values"`
              // the last chunk IS the final state. For other modes it may be
              // a node-update — the hook tolerates both via shape sniffing.
              fireOnce(lastChunk);
            } else {
              lastChunk = res.value;
            }
            return res;
          },
          async return(value?: unknown) {
            // Consumer broke early — still fire the hook with what we have.
            fireOnce(lastChunk);
            if (typeof inner.return === "function") {
              return inner.return(value);
            }
            return { value: undefined, done: true };
          },
          async throw(err?: unknown) {
            // No hook on throw — graph state is by definition incomplete.
            if (typeof inner.throw === "function") {
              return inner.throw(err);
            }
            throw err;
          },
        };
      },
    };
    return wrapped;
  };

  // Try to overwrite as own properties. If the graph is frozen, fall
  // back to wrapping the prototype-bound methods (best-effort, but
  // tests will catch any regression).
  try {
    Object.defineProperty(graph, "invoke", {
      value: wrappedInvoke,
      writable: true,
      configurable: true,
      enumerable: false,
    });
    Object.defineProperty(graph, "stream", {
      value: wrappedStream,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  } catch (err) {
    throw new DarwinEvolutionHookError(
      "withDarwinEvolution: could not wrap graph.invoke / graph.stream " +
        "(graph instance is frozen or non-configurable). Consider wrapping the " +
        "graph at compile time instead.",
      { cause: err },
    );
  }

  return graph;
}
