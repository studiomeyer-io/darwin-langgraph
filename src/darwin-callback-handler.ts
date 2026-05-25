/**
 * Surface 4 (V0.2) — `DarwinCallbackHandler`.
 *
 * Drop-in replacement for {@link withDarwinEvolution} that uses
 * LangChain's canonical `BaseCallbackHandler` mechanism instead of
 * monkey-patching `graph.invoke` / `graph.stream`. The same trajectory
 * hook fires, the same `nodeMap` routing applies, but the integration
 * is now LangGraph-native — no method overwrites, no concurrent-invoke
 * Set<symbol> dance, no streamMode gymnastics.
 *
 * Usage:
 * ```ts
 * import { DarwinCallbackHandler } from "darwin-langgraph";
 *
 * const handler = new DarwinCallbackHandler({
 *   nodeMap: { research: "researcher" },
 *   onTrajectory: (event) => {
 *     console.log(event.nodeName, event.trajectory.toolCalls.length);
 *   },
 * });
 *
 * const result = await graph.invoke(
 *   { task: "What is GEPA?" },
 *   { callbacks: [handler] },
 * );
 * ```
 *
 * Design notes (S1185 V0.2):
 *   - **runId → runName mapping.** LangChain invokes `handleChainStart`
 *     with the `runName` arg (the node name in LangGraph's case) and
 *     a unique `runId`. We cache that mapping. On `handleChainEnd` we
 *     look up the name, find the matching `nodeMap` entry, and dispatch
 *     `onTrajectory`.
 *   - **Fire-and-forget.** Like the v0.1 monkey-patch wrapper, hook
 *     errors are swallowed with one warn-once per handler instance.
 *   - **No mutation of LangGraph internals.** This handler never touches
 *     `graph.invoke` or `graph.stream` — registering it via the standard
 *     `{ callbacks: [...] }` option is the only side effect, which is
 *     LangChain's documented integration point (matches Langfuse,
 *     Braintrust, LangSmith handler patterns).
 *   - **Stream-mode-agnostic.** Works identically with `invoke`,
 *     `stream` (any streamMode), and `streamEvents` because the chain
 *     callbacks fire regardless of how the consumer iterates.
 *   - **Concurrent runs work natively.** LangChain's runId is unique
 *     per call — no shared-counter race condition is possible.
 *   - **Backwards compat.** `withDarwinEvolution` from v0.1 still works
 *     (marked `@deprecated`) and produces the same `DarwinTrajectoryEvent`
 *     payload shape. Migration is one line: replace
 *     `withDarwinEvolution(graph, opts)` with
 *     `graph.invoke(input, { callbacks: [new DarwinCallbackHandler(opts)] })`.
 */

import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { ChainValues } from "@langchain/core/utils/types";
import type { ExecutionTrace } from "darwin-agents";

import { DarwinEvolutionHookError } from "./errors.js";
import type {
  DarwinEvolutionOptions,
  DarwinNodeMapEntry,
  DarwinTrajectoryEvent,
} from "./with-darwin-evolution.js";

/**
 * V0.3 — extra options on top of `DarwinEvolutionOptions`. Pass to
 * `new DarwinCallbackHandler({ ...opts, maxInFlightRuns })`.
 *
 * NEW V0.3 (S1187).
 */
export interface DarwinCallbackHandlerOptions extends DarwinEvolutionOptions {
  /**
   * Maximum number of in-flight `runId → nodeName` mappings the handler
   * holds at once. If `handleChainEnd` / `handleChainError` never fires
   * (LangGraph internal bug, OS-level kill of the worker mid-invoke,
   * etc.) the map would otherwise grow without bound and leak memory.
   *
   * When the limit is exceeded, the OLDEST entry is evicted and a
   * one-shot warning is logged. Default: 1024 (enough for typical
   * fan-out patterns with safety margin, small enough to surface real
   * leaks within minutes of an incident).
   *
   * Set to `Infinity` to opt out — discouraged in production.
   */
  maxInFlightRuns?: number;
}

/**
 * Resolved entry from `DarwinEvolutionOptions.nodeMap`. Same shape used
 * internally by {@link withDarwinEvolution}.
 */
interface ResolvedNodeMapEntry {
  agentName: string;
  trajectoryKey: string;
}

/**
 * Internal state per tracked run. Holds the mapped node name plus —
 * NEW V0.3 (S1187) — the parentRunId from LangChain's callback contract.
 * The parentRunId is propagated into {@link DarwinTrajectoryEvent} so
 * downstream consumers (OTEL, Langfuse, LangSmith) can rebuild the span
 * hierarchy without an extra side-channel.
 */
interface InFlightRun {
  nodeName: string;
  parentRunId: string | undefined;
}

/** Default cap. Aligned with reasonable LangGraph fan-out (~1k nodes / minute). */
const DEFAULT_MAX_IN_FLIGHT_RUNS = 1024;

function isExecutionTrace(value: unknown): value is ExecutionTrace {
  if (!value || typeof value !== "object") return false;
  const v = value as { version?: unknown; toolCalls?: unknown; errors?: unknown };
  // R1 V0.2 Critic Finding 2 (S1185): require shape-tightness, not just
  // version. Downstream consumers (e.g. toOtelAttributes) read
  // `toolCalls.length` directly — a malformed trace with missing arrays
  // would crash there. Guard explicitly.
  return (
    v.version === 1 &&
    Array.isArray(v.toolCalls) &&
    Array.isArray(v.errors)
  );
}

function normaliseNodeMap(
  nodeMap: Record<string, DarwinNodeMapEntry>,
  defaultKey: string,
): Map<string, ResolvedNodeMapEntry> {
  const resolved = new Map<string, ResolvedNodeMapEntry>();
  for (const [nodeName, entry] of Object.entries(nodeMap)) {
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
        `DarwinCallbackHandler: nodeMap entry for "${nodeName}" must be a string or ` +
          `{ agentName, trajectoryKey }, got ${typeof entry}.`,
      );
    }
  }
  return resolved;
}

/**
 * LangChain `BaseCallbackHandler` that listens for LangGraph node-chain
 * events and dispatches Darwin trajectory hooks. Pass it via the
 * standard `{ callbacks: [...] }` option to any `invoke`/`stream`/`streamEvents`
 * call on a compiled `StateGraph`.
 */
export class DarwinCallbackHandler extends BaseCallbackHandler {
  public override readonly name = "DarwinCallbackHandler";
  public override readonly awaitHandlers = false;

  private readonly resolved: Map<string, ResolvedNodeMapEntry>;
  private readonly onTrajectory: DarwinEvolutionOptions["onTrajectory"];
  /**
   * runId → in-flight run state. Map preserves insertion order so the
   * oldest entry is always at `.keys().next().value` for LRU eviction
   * when the cap is exceeded (V0.3 hung-invoke guard).
   */
  private readonly runIdToName: Map<string, InFlightRun> = new Map();
  private readonly maxInFlightRuns: number;
  private warned = false;
  private evictionWarned = false;

  constructor(opts: DarwinCallbackHandlerOptions) {
    super();
    if (!opts || !opts.nodeMap || Object.keys(opts.nodeMap).length === 0) {
      throw new DarwinEvolutionHookError(
        "DarwinCallbackHandler: opts.nodeMap is required and must contain at least one entry.",
      );
    }
    const defaultKey = opts.defaultTrajectoryKey ?? "darwinTrajectory";
    this.resolved = normaliseNodeMap(opts.nodeMap, defaultKey);
    this.onTrajectory = opts.onTrajectory;
    // V0.3 (S1187): hung-invoke guard. NaN / negative / non-number falls
    // back to default. Infinity disables the cap (opt-out).
    const raw = opts.maxInFlightRuns;
    if (raw === Infinity) {
      this.maxInFlightRuns = Infinity;
    } else if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
      this.maxInFlightRuns = Math.floor(raw);
    } else {
      this.maxInFlightRuns = DEFAULT_MAX_IN_FLIGHT_RUNS;
    }
  }

  /**
   * Capture the run-id → node-name mapping.
   *
   * Implementation note (S1185 V0.2 — live-debug against @langchain/langgraph@1.3.x):
   * `metadata.langgraph_node` is the stable, reliable source for the
   * StateGraph node name. LangGraph populates it on every node-chain
   * invocation. The `runName` parameter slot in `@langchain/core`'s
   * `BaseCallbackHandler` d.ts is undefined for LangGraph chains at
   * runtime — we keep it as a fallback for non-LangGraph chains.
   */
  override handleChainStart(
    _chain: unknown,
    _inputs: ChainValues,
    runId: string,
    _runType?: string,
    _tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string,
    parentRunId?: string,
    _extra?: Record<string, unknown>,
  ): void {
    // Primary source: metadata.langgraph_node (set by LangGraph internals).
    let nodeName: string | undefined;
    if (metadata && typeof metadata === "object") {
      const m = metadata as Record<string, unknown>;
      if (typeof m["langgraph_node"] === "string") {
        nodeName = m["langgraph_node"];
      }
    }
    // Fallback: runName parameter (for non-LangGraph integrations).
    if (!nodeName && typeof runName === "string" && runName.length > 0) {
      nodeName = runName;
    }
    if (!nodeName) return;
    // Only track names that map to a known node. Reduces memory and
    // makes lookup in handleChainEnd a simple `.has()` check.
    if (!this.resolved.has(nodeName)) return;

    // V0.3 (S1187): hung-invoke guard. If we are about to exceed the cap
    // AND the runId is genuinely new (not a re-fire), evict the oldest
    // entry. Map iteration order is insertion order — the first key is
    // the oldest. Warn once per handler instance so a real leak shows up
    // in logs without spamming.
    if (
      this.maxInFlightRuns !== Infinity &&
      !this.runIdToName.has(runId) &&
      this.runIdToName.size >= this.maxInFlightRuns
    ) {
      const oldest = this.runIdToName.keys().next().value;
      if (oldest !== undefined) {
        this.runIdToName.delete(oldest);
      }
      if (!this.evictionWarned) {
        this.evictionWarned = true;
        console.warn(
          `[darwin-langgraph] DarwinCallbackHandler: in-flight runs exceeded ` +
            `${this.maxInFlightRuns} — evicting oldest entry. This usually ` +
            `means handleChainEnd / handleChainError did not fire for some ` +
            `runs (worker crash, parent invoke aborted mid-flight, or ` +
            `LangGraph internal bug). Subsequent evictions are silent.`,
        );
      }
    }

    this.runIdToName.set(runId, {
      nodeName,
      parentRunId: typeof parentRunId === "string" ? parentRunId : undefined,
    });
  }

  /**
   * When a node-chain finishes, look up its name, locate the matching
   * trajectory in `outputs`, and dispatch onTrajectory.
   *
   * `outputs` carries the state update the node returned — which may be
   * a partial state (just the new keys). When the node was wrapped via
   * {@link createDarwinNode}, the trajectoryKey lives directly on that
   * partial state under its configured name.
   */
  override handleChainEnd(
    outputs: ChainValues,
    runId: string,
    _parentRunId?: string,
    _tags?: string[],
    _kwargs?: { inputs?: ChainValues },
  ): void {
    const inFlight = this.runIdToName.get(runId);
    if (!inFlight) return;
    // One-shot cleanup of the mapping so completed runs don't leak.
    // R1 V0.2 Critic Finding 1 (S1185): the `runIdToName.delete` here
    // is the ONLY dedup we need — LangGraph guarantees `handleChainEnd`
    // fires exactly once per `runId`, and after deletion any second
    // call returns early at `if (!inFlight)`. The pre-V0.2 `firedRuns`
    // Set was redundant AND leaked unbounded — removed.
    this.runIdToName.delete(runId);

    if (!this.onTrajectory) return;

    const entry = this.resolved.get(inFlight.nodeName);
    if (!entry) return;

    if (outputs === null || typeof outputs !== "object") return;
    const trajectory = (outputs as Record<string, unknown>)[entry.trajectoryKey];
    if (!isExecutionTrace(trajectory)) return;

    const frozen = Object.freeze({ ...(outputs as Record<string, unknown>) });
    // V0.3 (S1187): propagate runId + parentRunId so OTEL exporters,
    // Langfuse, LangSmith, etc. can rebuild the span hierarchy from the
    // event payload alone (no separate runId-tracking side-channel).
    const event: DarwinTrajectoryEvent = {
      nodeName: inFlight.nodeName,
      agentName: entry.agentName,
      trajectory,
      finalState: frozen,
      runId,
      ...(inFlight.parentRunId !== undefined ? { parentRunId: inFlight.parentRunId } : {}),
    };

    // Fire-and-forget. The handler base class supports async returns
    // but we don't want to block the chain end on slow user callbacks.
    void Promise.resolve()
      .then(() => this.onTrajectory!(event))
      .catch((err) => this.swallow(err));
  }

  /**
   * Forget the in-flight runId when a chain errors out. We don't fire
   * the hook on error — the trajectory is by definition incomplete.
   */
  override handleChainError(
    _err: Error,
    runId: string,
    _parentRunId?: string,
  ): void {
    this.runIdToName.delete(runId);
  }

  private swallow(err: unknown): void {
    // R1 V0.2 Critic Finding 5 (S1185): do NOT short-circuit on falsy
    // `err` — `throw 0` / `throw ""` / `throw null` from user callbacks
    // should still surface in logs (silent-failure is worse than noisy).
    if (this.warned) return;
    this.warned = true;
    console.warn(
      `[darwin-langgraph] DarwinCallbackHandler.onTrajectory threw — swallowed. ` +
        `Subsequent throws will be silent. Original error: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  /**
   * Helper for tests + debug introspection — returns how many in-flight
   * chain runs we are currently tracking. Should be 0 between
   * top-level invocations.
   */
  public getInFlightCount(): number {
    return this.runIdToName.size;
  }
}
