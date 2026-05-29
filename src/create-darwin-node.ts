/**
 * Surface 1 — `createDarwinNode(agent, opts?)`.
 *
 * Wraps a Darwin `AgentDefinition` as a LangGraph node action. The
 * returned function:
 *   1. Reads the task from `state[opts.taskKey ?? "task"]`.
 *   2. Invokes `runAgent(agent, task, { memory })` from `darwin-agents`.
 *   3. Writes the agent output to `state[opts.outputKey ?? "output"]`.
 *   4. Optionally writes the captured `ExecutionTrace` to
 *      `state[opts.trajectoryKey ?? "darwinTrajectory"]` so downstream
 *      nodes (or the evolution hook) can read it.
 *
 * Design notes (S1185):
 *   - **Non-generic return type.** The adapter returns `(state, config?) =>
 *     Promise<Record<string, unknown>>`. LangGraph accepts any function
 *     with the shape `(state, config?) => Partial<State>` as a NodeAction;
 *     leaving the return type generic-free keeps the public API trivial
 *     to consume from JS and TS alike. Strong typing is recovered via
 *     `darwinAnnotation()` on the StateGraph side.
 *   - **`runAgent` errors are wrapped** in `DarwinNodeError` so consumers
 *     can `instanceof`-check adapter failures vs upstream failures.
 *   - **`opts.onResult` is fire-and-forget swallowed.** A user callback
 *     must NEVER break the graph; we await it, but suppress any throw
 *     and surface it via `console.warn` once per Node. Mirrors the
 *     `darwinPostRun` no-throw guarantee from `agents/lib/darwin-hook.ts`.
 *   - **No `ANTHROPIC_API_KEY` manipulation.** `runAgent` makes its own
 *     subprocess/provider decisions; consumers running on Claude Max
 *     subscriptions must `delete process.env.ANTHROPIC_API_KEY` in
 *     their own bootstrap (documented in README).
 */

import { isGraphInterrupt } from "@langchain/langgraph";
import { runAgent } from "darwin-agents";
import type {
  AgentDefinition,
  DarwinConfig,
  RunResult,
} from "darwin-agents";

import { DarwinNodeError } from "./errors.js";

/**
 * LangGraph HITL detector (R1 Research Finding 5, refined by R2 Research
 * Finding 1, S1185).
 *
 * When `interrupt()` is called inside a downstream node during a
 * `runAgent` run, LangGraph throws a typed error to surface the HITL
 * pause. The adapter MUST re-throw that error untouched — wrapping it
 * in `DarwinNodeError` would swallow the interrupt and break the
 * `Command({ resume })` protocol.
 *
 * Initially (R1) we hand-rolled a `name === "GraphInterrupt"` duck-type.
 * R2 surfaced two issues with that approach:
 *   1. Production minifiers (esbuild/Terser/SWC) rewrite class.name
 *      and constructor.name unless `keep_classnames` is set — breaking
 *      the constructor-name fallback for bundled consumers.
 *   2. The real-world case throws `NodeInterrupt` (a `GraphInterrupt`
 *      subclass), NOT raw `GraphInterrupt`. The hand-rolled string
 *      check missed it.
 *
 * Fix: import `isGraphInterrupt` from `@langchain/langgraph`'s main
 * entry — it is a stable PUBLIC export and uses LangGraph's internal
 * `unminifiable_name` static-getter pattern that survives minification
 * AND covers both `GraphInterrupt` and `NodeInterrupt`. The previous
 * concern about "internal-ish module paths" was wrong — it lives in the
 * top-level barrel.
 */

/**
 * Mirror of `darwin-agents` `RunOptions` — narrower because the adapter
 * sets `taskType` and `promptVersion` implicitly. Exposed as `runOptions`
 * on {@link CreateDarwinNodeOptions} so consumers can forward
 * `model` / `maxTurns` / `timeout` / `autonomous` flags to `runAgent`
 * without re-importing `darwin-agents`.
 *
 * If the upstream `RunOptions` shape changes in a future `darwin-agents`
 * release, the build will break here on purpose — peer-dep semver
 * guarantees additive-only changes inside the alpha range, but real
 * drift happens (see `nex_learn fcfc928f`).
 */
export interface DarwinRunOptionsPassthrough {
  model?: string;
  maxTurns?: number;
  taskType?: string;
  config?: DarwinConfig;
  promptVersion?: string;
  cwd?: string;
  timeout?: number;
  autonomous?: boolean;
}

/**
 * V0.4 (S1235) — runtime info surfaced from the LangGraph `RunnableConfig`
 * for the `onAttempt` callback. Lets consumers branch on retries (e.g.
 * fall back to a cheaper model after the first attempt fails — the
 * canonical LangGraph retryPolicy pattern from
 * langchain.com/oss/javascript/langgraph/use-graph-api#access-execution-info-inside-a-node).
 *
 * `nodeAttempt` is `1` for the first execution; if a retry policy is
 * attached via `addNode("name", fn, { retryPolicy })` and the node
 * throws, LangGraph re-fires with `nodeAttempt = 2`, etc.
 *
 * NEW V0.4 (S1235).
 */
export interface DarwinNodeAttemptInfo {
  /** Current attempt number (1-indexed, increments per retry). */
  nodeAttempt: number;
  /**
   * LangGraph step counter for this node execution within the graph
   * run. Read from `config.metadata.langgraph_step` (the canonical
   * 1.3.x source) — R1 Research Finding 2 (S1235) corrected the
   * source: it is metadata, NOT `executionInfo`.
   */
  langGraphStep?: number;
  /**
   * V0.4 (R1 Research Finding 2, S1235) — first-attempt timestamp as
   * ISO 8601 string when LangGraph surfaces it. Useful to compute
   * retry-attempt latency in fallback paths. Read from
   * `config.runtime.executionInfo.nodeFirstAttemptTime` per
   * LangGraph PR #7363 — value may be `null` on Platform-managed
   * graphs (PR #7406 workaround).
   */
  nodeFirstAttemptTime?: string;
  /** LangGraph thread id (from `config.configurable.thread_id`). */
  threadId?: string;
  /** Raw runtime info object — passed through for power-users. */
  raw: Record<string, unknown> | undefined;
}

/**
 * Options accepted by {@link createDarwinNode}.
 *
 * All keys are optional. Defaults match the channel names returned by
 * {@link darwinAnnotation} so the most common case (`createDarwinNode(myAgent)`
 * inside `darwinAnnotation()`) needs zero configuration.
 */
export interface CreateDarwinNodeOptions {
  /** State property to read the task from. Default: `"task"`. */
  taskKey?: string;
  /** State property to write the agent output to. Default: `"output"`. */
  outputKey?: string;
  /** State property to write the captured trajectory to. Default: `"darwinTrajectory"`. */
  trajectoryKey?: string;
  /**
   * Passthrough options forwarded to `darwin-agents.runAgent()`. Use this
   * to override `model`, `maxTurns`, `timeout`, `cwd`, `autonomous`, or to
   * provide a custom `DarwinConfig` (data dir, MCP servers, etc.).
   *
   * Memory resolution lives inside `darwin-agents` itself — set
   * `DARWIN_POSTGRES_URL` / `DARWIN_SQLITE_PATH` env vars or pass a
   * `config.dataDir` here. The adapter never instantiates a memory
   * provider on its own.
   */
  runOptions?: DarwinRunOptionsPassthrough;
  /**
   * Persist the captured `ExecutionTrace` in graph state. Default `true`.
   * Set `false` to skip trajectory propagation when memory pressure is a
   * concern (long-running streams) or when the consumer reads
   * trajectories from Darwin's own memory backend.
   */
  captureTrace?: boolean;
  /**
   * Fire-and-forget side-effect after every successful run. Receives the
   * full `RunResult`. **Errors are swallowed** — never let a callback
   * break the LangGraph node.
   */
  onResult?: (result: RunResult) => void | Promise<void>;
  /**
   * V0.4 — Fired before `runAgent` with the runtime info LangGraph
   * surfaces via `config.runtime.executionInfo`. Use this to:
   *   - Log retry behaviour (`nodeAttempt > 1` means LangGraph's
   *     retryPolicy decided to retry).
   *   - Switch to a cheaper / faster fallback model on retries
   *     (mutate `runOptions` via closure capture).
   *   - Forward step / thread context to upstream tracing systems.
   *
   * Pairs naturally with LangGraph's `addNode(name, fn, { retryPolicy })`
   * — the adapter does NOT add its own retry layer (would conflict).
   *
   * **Errors are swallowed** with a one-shot warn per node, same contract
   * as `onResult`.
   *
   * NEW V0.4 (S1235).
   */
  onAttempt?: (info: DarwinNodeAttemptInfo) => void | Promise<void>;
}

/**
 * Type alias for the function returned by {@link createDarwinNode}.
 * Matches the loose `NodeAction` contract from `@langchain/langgraph`:
 * `(state, config?) => Promise<Partial<State>>`.
 */
export type DarwinNodeFn = (
  state: Record<string, unknown>,
  config?: unknown,
) => Promise<Record<string, unknown>>;

/**
 * Build a LangGraph node from a Darwin agent.
 *
 * @example
 * ```ts
 * import { StateGraph } from "@langchain/langgraph";
 * import { createDarwinNode, darwinAnnotation } from "darwin-langgraph";
 * import { defineAgent } from "darwin-agents";
 *
 * const researcher = defineAgent({
 *   name: "researcher",
 *   role: "Topic Researcher",
 *   description: "Researches a topic and returns 5 bullet points.",
 *   systemPrompt: "Return exactly 5 bullets.",
 * });
 *
 * const graph = new StateGraph(darwinAnnotation())
 *   .addNode("research", createDarwinNode(researcher))
 *   .addEdge("__start__", "research")
 *   .compile();
 *
 * const result = await graph.invoke({ task: "What is GEPA?" });
 * console.log(result.output);
 * ```
 */
export function createDarwinNode(
  agent: AgentDefinition,
  opts: CreateDarwinNodeOptions = {},
): DarwinNodeFn {
  if (!agent || typeof agent !== "object" || typeof agent.name !== "string") {
    throw new DarwinNodeError(
      "createDarwinNode: agent must be an AgentDefinition with a `name` field.",
      typeof agent === "object" && agent !== null && "name" in agent
        ? String((agent as { name?: unknown }).name ?? "<unknown>")
        : "<unknown>",
    );
  }

  const taskKey = opts.taskKey ?? "task";
  const outputKey = opts.outputKey ?? "output";
  const trajectoryKey = opts.trajectoryKey ?? "darwinTrajectory";
  const captureTrace = opts.captureTrace !== false;
  const agentName = agent.name;
  const onResult = opts.onResult;
  const onAttempt = opts.onAttempt;
  const runOptions = opts.runOptions ?? {};

  // Track whether we already warned about a swallowed callback so the
  // log stays at most one line per node, not one per invocation.
  let onResultWarned = false;
  let onAttemptWarned = false;

  return async function darwinNode(state, config) {
    if (state === null || typeof state !== "object") {
      throw new DarwinNodeError(
        `createDarwinNode(${agentName}): state must be an object, got ${typeof state}.`,
        agentName,
      );
    }

    const rawTask = (state as Record<string, unknown>)[taskKey];
    if (typeof rawTask !== "string" || rawTask.length === 0) {
      throw new DarwinNodeError(
        `createDarwinNode(${agentName}): state["${taskKey}"] must be a non-empty string, ` +
          `got ${rawTask === undefined ? "undefined" : typeof rawTask}.`,
        agentName,
      );
    }

    // V0.4 (S1235): surface LangGraph runtime info to the optional
    // onAttempt callback. The shape of `config.runtime.executionInfo` is
    // defined in @langchain/langgraph 1.3+ via PR #7363 (2026-03-31).
    //
    // R1 Research Finding 2 fix (S1235): `langGraphStep` does NOT live
    // on `executionInfo` — it is in `config.metadata.langgraph_step`.
    // `executionInfo` carries `nodeAttempt` and `nodeFirstAttemptTime`
    // among other identifiers. We read both defensively so older
    // LangGraph versions don't crash this node.
    if (onAttempt && config && typeof config === "object") {
      const c = config as Record<string, unknown>;
      const runtime = c.runtime as Record<string, unknown> | undefined;
      const executionInfo = runtime?.executionInfo as
        | {
            nodeAttempt?: unknown;
            nodeFirstAttemptTime?: unknown;
          }
        | undefined;
      const metadata = c.metadata as Record<string, unknown> | undefined;
      const configurable = c.configurable as
        | { thread_id?: unknown }
        | undefined;
      const nodeAttempt =
        typeof executionInfo?.nodeAttempt === "number" &&
        Number.isFinite(executionInfo.nodeAttempt) &&
        executionInfo.nodeAttempt >= 1
          ? executionInfo.nodeAttempt
          : 1;
      // R1 Research Finding 2: langgraph_step lives in metadata.
      const rawStep = metadata?.["langgraph_step"];
      const langGraphStep =
        typeof rawStep === "number" && Number.isFinite(rawStep)
          ? rawStep
          : undefined;
      // R1 Research Finding 2: nodeFirstAttemptTime from executionInfo.
      const rawFirstAttempt = executionInfo?.nodeFirstAttemptTime;
      const nodeFirstAttemptTime =
        typeof rawFirstAttempt === "string" && rawFirstAttempt.length > 0
          ? rawFirstAttempt
          : undefined;
      const threadId =
        typeof configurable?.thread_id === "string"
          ? configurable.thread_id
          : undefined;
      try {
        await onAttempt({
          nodeAttempt,
          ...(langGraphStep !== undefined ? { langGraphStep } : {}),
          ...(nodeFirstAttemptTime !== undefined
            ? { nodeFirstAttemptTime }
            : {}),
          ...(threadId !== undefined ? { threadId } : {}),
          raw: runtime,
        });
      } catch (err) {
        if (!onAttemptWarned) {
          onAttemptWarned = true;
          console.warn(
            `[darwin-langgraph] onAttempt callback for "${agentName}" threw — ` +
              `swallowed. Subsequent throws will be silent. Original error: ` +
              `${(err as Error)?.message ?? String(err)}`,
          );
        }
      }
    }

    let result: RunResult;
    try {
      result = await runAgent(agent, rawTask, runOptions);
    } catch (err) {
      // R1 Research Finding 5: LangGraph `interrupt()` surfaces as a
      // `GraphInterrupt` thrown from inside the node call stack. The
      // adapter MUST re-throw it untouched so LangGraph's HITL
      // persistence + resume protocol works. Only non-interrupt errors
      // get wrapped in `DarwinNodeError`.
      if (isGraphInterrupt(err)) {
        throw err;
      }
      throw new DarwinNodeError(
        `createDarwinNode(${agentName}): runAgent failed: ${(err as Error)?.message ?? String(err)}`,
        agentName,
        { cause: err },
      );
    }

    if (onResult) {
      try {
        await onResult(result);
      } catch (err) {
        if (!onResultWarned) {
          onResultWarned = true;
          console.warn(
            `[darwin-langgraph] onResult callback for "${agentName}" threw — swallowed. ` +
              `Subsequent throws will be silent. Original error: ` +
              `${(err as Error)?.message ?? String(err)}`,
          );
        }
      }
    }

    const update: Record<string, unknown> = {
      [outputKey]: result.output,
    };
    if (captureTrace && result.experiment?.trajectory) {
      update[trajectoryKey] = result.experiment.trajectory;
    }
    return update;
  };
}
