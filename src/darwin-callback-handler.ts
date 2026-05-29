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
 * Highest `ExecutionTrace.version` this handler natively understands.
 * The forward-compat guard in {@link isExecutionTrace} warns once for
 * higher versions but still emits them (structural shape covers the
 * required fields) so a Darwin upgrade ahead of the adapter doesn't
 * silently drop trajectories.
 *
 * NEW V0.4 (S1235).
 */
export const MAX_KNOWN_TRACE_VERSION = 1;

/**
 * Surface 8 (V0.4) — `DarwinToolEvent`.
 *
 * Emitted by {@link DarwinCallbackHandler.onToolEvent} whenever LangGraph
 * surfaces a tool-chain start, end, or error inside a tracked node-chain.
 * Lets consumers correlate per-tool spans with the parent agent trajectory
 * BEFORE the chain completes — useful for live OTEL span emission,
 * progress UIs, and abort-on-tool-failure logic.
 *
 * Phase semantics:
 *   - `"start"` — populated `input`, no `output`/`error`. Fired from
 *     `handleToolStart`.
 *   - `"end"` — populated `output`, no `error`. Fired from `handleToolEnd`.
 *   - `"error"` — populated `error`, no `output`. Fired from `handleToolError`.
 *
 * NEW V0.4 (S1235).
 */
export interface DarwinToolEvent {
  /** Node name the tool ran under (resolved from `runIdToName` via the
   * tool-chain's parentRunId — the chain runId from `handleChainStart`). */
  nodeName: string;
  /** Darwin agent name (from `nodeMap`). */
  agentName: string;
  /** Tool name LangChain passed in `handleToolStart` (often the function name). */
  toolName: string;
  /** Phase of the tool-chain event. */
  phase: "start" | "end" | "error";
  /** LangChain runId of this tool-chain (NOT the parent chain). */
  runId: string;
  /** LangChain parentRunId — chain runId of the node the tool ran under. */
  parentRunId: string;
  /** Raw input arg passed to `handleToolStart`. Only present on phase=start. */
  input?: string;
  /** Raw output from `handleToolEnd`. Only present on phase=end. */
  output?: unknown;
  /** Error from `handleToolError`. Only present on phase=error. */
  error?: Error;
}

/**
 * V0.3 — extra options on top of `DarwinEvolutionOptions`. Pass to
 * `new DarwinCallbackHandler({ ...opts, maxInFlightRuns })`.
 *
 * NEW V0.3 (S1187), extended V0.4 (S1235).
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

  /**
   * V0.4 — soft cap on the serialised trajectory size before it is
   * surfaced through `onTrajectory`. When a trajectory's `JSON.stringify`
   * length exceeds `maxTrajectoryBytes`, the handler emits a one-shot
   * warning and replaces the `trajectory` field on the event with a
   * structurally-compatible BUT minimal stub (same `version`, empty
   * `toolCalls` and `errors`, original counts and capturedAt preserved).
   * Downstream consumers can detect the swap by inspecting
   * `event.trajectoryTruncated === true`.
   *
   * Default: `262_144` (256 KiB). Set to `Infinity` to opt out.
   *
   * NEW V0.4 (S1235).
   */
  maxTrajectoryBytes?: number;

  /**
   * V0.4 — Fired for every tool-chain start / end / error observed inside
   * a tracked node-chain. Use this to emit per-tool OTEL spans, drive a
   * progress UI, or abort downstream work on a tool failure.
   *
   * Errors thrown inside `onToolEvent` are swallowed with a single warn
   * per handler instance — never breaks the graph.
   *
   * NEW V0.4 (S1235).
   */
  onToolEvent?: (event: DarwinToolEvent) => void | Promise<void>;
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
 *
 * V0.4 (S1235) — adds `pendingTools`: a counter of tool-chain runIds
 * that started under this chain and have not yet ended/errored. The
 * counter lets `handleChainEnd` keep the chain entry alive in
 * `runIdToName` until pending tool events have been dispatched, fixing
 * the race where `handleChainEnd` synchronously deletes the entry and
 * subsequent `handleToolEnd` lookups return undefined (R1 P1-4 fix).
 *
 * V0.4 (S1235) — `finalized` marks chains that received
 * `handleChainEnd` but kept the entry alive for pending tools. When
 * pending hits zero we clean up.
 */
interface InFlightRun {
  nodeName: string;
  parentRunId: string | undefined;
  pendingTools: number;
  finalized: boolean;
}

/** Default cap. Aligned with reasonable LangGraph fan-out (~1k nodes / minute). */
const DEFAULT_MAX_IN_FLIGHT_RUNS = 1024;

/** Default size cap for trajectory `onTrajectory` emission (256 KiB). */
const DEFAULT_MAX_TRAJECTORY_BYTES = 262_144;

/**
 * Process-wide flag so the unknown-version warning fires once per
 * process even across multiple handler instances. Exported intentionally
 * undefined — re-bound via module-reload in tests.
 */
let unknownTraceVersionWarned = false;

function isExecutionTrace(value: unknown): value is ExecutionTrace {
  if (!value || typeof value !== "object") return false;
  const v = value as { version?: unknown; toolCalls?: unknown; errors?: unknown };
  // R1 V0.2 Critic Finding 2 (S1185): require shape-tightness, not just
  // version. Downstream consumers (e.g. toOtelAttributes) read
  // `toolCalls.length` directly — a malformed trace with missing arrays
  // would crash there. Guard explicitly.
  //
  // V0.4 (S1235): forward-compat — accept v ≥ 1 as long as the structural
  // shape `toolCalls + errors` is preserved. A future Darwin release that
  // bumps the version while adding fields will still flow through; only
  // structurally-incompatible payloads are dropped. We warn once per
  // process when we observe a higher-than-known version so an out-of-date
  // adapter dependency is loud rather than silent.
  if (
    typeof v.version !== "number" ||
    !Number.isFinite(v.version) ||
    v.version < 1 ||
    !Array.isArray(v.toolCalls) ||
    !Array.isArray(v.errors)
  ) {
    return false;
  }
  if (v.version > MAX_KNOWN_TRACE_VERSION && !unknownTraceVersionWarned) {
    unknownTraceVersionWarned = true;
    console.warn(
      `[darwin-langgraph] Observed ExecutionTrace.version=${v.version} — ` +
        `this adapter knows up to v${MAX_KNOWN_TRACE_VERSION}. Emitting as ` +
        `compatible v${MAX_KNOWN_TRACE_VERSION}-shape; upgrade darwin-langgraph ` +
        `to access any new fields. Subsequent unknown-version observations ` +
        `are silent.`,
    );
  }
  return true;
}

/**
 * Build a structurally-compatible BUT minimal stub when a trajectory's
 * serialised size exceeds the configured cap. Preserves the aggregate
 * counts (turns / textBlocks / mcp invocations / errors-count via empty
 * array — counts go through via the dedicated count fields) plus
 * `capturedAt` for traceability. Caller-visible flag
 * `trajectoryTruncated = true` is set on the event payload so consumers
 * can branch on it.
 */
function buildTruncatedTrace(t: ExecutionTrace): ExecutionTrace {
  // R1 P1-2 fix (S1235): shallow-copy `tokenUsage` instead of leaking
  // the original object reference. The original trajectory may carry
  // BigInt fields (some providers expose 64-bit token counts) which
  // downstream JSON.stringify cannot handle — coerce them to Number
  // via the explicit spread/normaliser.
  const tokenUsage = t.tokenUsage
    ? Object.fromEntries(
        Object.entries(t.tokenUsage).map(([k, v]) => [
          k,
          typeof v === "bigint" ? Number(v) : v,
        ]),
      )
    : undefined;
  return {
    version: t.version,
    toolCalls: [],
    textBlockCount: t.textBlockCount,
    turnCount: t.turnCount,
    mcpInvocations: t.mcpInvocations,
    errors: [],
    capturedAt: t.capturedAt,
    ...(tokenUsage ? { tokenUsage: tokenUsage as ExecutionTrace["tokenUsage"] } : {}),
  };
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
  private readonly onToolEvent: DarwinCallbackHandlerOptions["onToolEvent"];
  /**
   * runId → in-flight run state. Map preserves insertion order so the
   * oldest entry is always at `.keys().next().value` for LRU eviction
   * when the cap is exceeded (V0.3 hung-invoke guard).
   */
  private readonly runIdToName: Map<string, InFlightRun> = new Map();
  /**
   * V0.4 (R1 P1-1 fix, S1235) — `toolRunId → toolName` cache populated
   * from `handleToolStart` and consumed by `handleToolEnd` /
   * `handleToolError`. LangChain v0.3 `handleToolEnd` does NOT reliably
   * carry the tool name in its signature (the slot was repurposed
   * across releases); reading `output.name` only works for some shapes
   * and yields "<anonymous-tool>" for the common ToolNode case.
   */
  private readonly toolRunIdToName: Map<string, string> = new Map();
  /**
   * V0.4 (R1 P1-1 fix, S1235) — pending callbacks keyed by parent chain
   * runId so we can also restore the chain's tool name at end-time even
   * after the `toolRunIdToName` entry is cleaned up.
   */
  private readonly maxInFlightRuns: number;
  /** V0.4 — byte cap before trajectory replacement. */
  private readonly maxTrajectoryBytes: number;
  /**
   * V0.4 (R1 P1-1 fix) — also cap the tool-name cache. Default matches
   * `maxInFlightRuns` since tool runs are children of chain runs.
   */
  private readonly maxInFlightToolRuns: number;
  /**
   * Pending trajectory dispatches keyed by chain runId. When a chain
   * ends with tools still in flight we hold the dispatch closure here
   * and fire it from the LAST `handleToolEnd` / `handleToolError`.
   *
   * V0.4 (R1 P1-4 fix, S1235).
   */
  private readonly pendingTrajectoryDispatch: Map<string, () => void> = new Map();
  private warned = false;
  private evictionWarned = false;
  private toolWarned = false;
  /** V0.4 — once-per-handler warn for trajectory size cap. */
  private trajectoryTruncatedWarned = false;

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
    this.onToolEvent = opts.onToolEvent;
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
    // V0.4 (S1235): trajectory size guard. Same shape as maxInFlightRuns.
    const rawBytes = opts.maxTrajectoryBytes;
    if (rawBytes === Infinity) {
      this.maxTrajectoryBytes = Infinity;
    } else if (
      typeof rawBytes === "number" &&
      Number.isFinite(rawBytes) &&
      rawBytes > 0
    ) {
      this.maxTrajectoryBytes = Math.floor(rawBytes);
    } else {
      this.maxTrajectoryBytes = DEFAULT_MAX_TRAJECTORY_BYTES;
    }
    // V0.4 (R1 P1-1 fix): tool-name cache cap mirrors the chain cap.
    this.maxInFlightToolRuns =
      this.maxInFlightRuns === Infinity
        ? Infinity
        : Math.max(this.maxInFlightRuns, 1) * 4;
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
      pendingTools: 0,
      finalized: false,
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
    // V0.4 (R1 P1-4 fix, S1235): defer the chain-entry cleanup if tool
    // events are still pending. Without this, `handleToolEnd` for a
    // still-executing tool would see `runIdToName.get(parentRunId) ===
    // undefined` and silently drop the tool event. We mark the entry
    // `finalized` so subsequent `handleChainStart` for the SAME runId
    // (which LangGraph never does, but defense-in-depth) is treated as
    // a re-fire and ignored; and we hold the trajectory dispatch in
    // `pendingTrajectoryDispatch` to fire from the last tool callback.
    inFlight.finalized = true;
    if (inFlight.pendingTools === 0) {
      this.runIdToName.delete(runId);
    }

    if (!this.onTrajectory) {
      if (inFlight.pendingTools === 0) {
        // Already cleaned up; nothing more to do.
        return;
      }
      // Caller does not care about the trajectory, just the tool events.
      // No pending dispatch needed; the tool-callback path will clean up
      // the chain entry when pending hits 0.
      return;
    }

    const entry = this.resolved.get(inFlight.nodeName);
    if (!entry) return;

    if (outputs === null || typeof outputs !== "object") return;
    const trajectoryRaw = (outputs as Record<string, unknown>)[entry.trajectoryKey];
    if (!isExecutionTrace(trajectoryRaw)) return;

    // V0.4 (S1235): size-guard. Run JSON.stringify ONCE and reuse its
    // length for the cap test — the result is discarded, we never log
    // raw payloads. JSON.stringify can throw on circular refs / BigInt
    // / Symbol values; defensive catch keeps the hook robust regardless.
    let serialisedSize = 0;
    try {
      serialisedSize = JSON.stringify(trajectoryRaw).length;
    } catch {
      // Unserialisable trajectories are themselves a signal worth
      // surfacing — treat as oversized so consumers see the replacement.
      serialisedSize = Number.POSITIVE_INFINITY;
    }
    let trajectory: ExecutionTrace = trajectoryRaw;
    let trajectoryTruncated = false;
    if (
      this.maxTrajectoryBytes !== Infinity &&
      serialisedSize > this.maxTrajectoryBytes
    ) {
      trajectory = buildTruncatedTrace(trajectoryRaw);
      trajectoryTruncated = true;
      if (!this.trajectoryTruncatedWarned) {
        this.trajectoryTruncatedWarned = true;
        console.warn(
          `[darwin-langgraph] DarwinCallbackHandler: trajectory for ` +
            `"${inFlight.nodeName}" was ${serialisedSize} bytes — exceeded ` +
            `${this.maxTrajectoryBytes} byte cap. Emitting structurally-` +
            `compatible minimal stub with the original counts preserved. ` +
            `Set DarwinCallbackHandlerOptions.maxTrajectoryBytes to raise ` +
            `the cap or Infinity to opt out. Subsequent truncations are silent.`,
        );
      }
    }

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
      ...(trajectoryTruncated ? { trajectoryTruncated: true } : {}),
    };

    const dispatch = (): void => {
      void Promise.resolve()
        .then(() => this.onTrajectory!(event))
        .catch((err) => this.swallow(err));
    };

    if (inFlight.pendingTools > 0) {
      // V0.4 (R1 P1-4 fix): defer the dispatch until all tool events
      // have surfaced so consumers see tool spans BEFORE the agent span
      // closes. The last tool callback drains this map.
      this.pendingTrajectoryDispatch.set(runId, dispatch);
    } else {
      dispatch();
    }
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
    // V0.4 (R1 P1-4): on error we discard pending trajectory dispatch —
    // an errored chain has no complete trajectory by definition.
    this.runIdToName.delete(runId);
    this.pendingTrajectoryDispatch.delete(runId);
  }

  /**
   * V0.4 (S1235) — tool-chain start event. LangGraph fires `handleToolStart`
   * for every tool-invocation a node performs (whether via `ToolNode`,
   * `createReactAgent`, or a custom tool-call dispatcher). We use the
   * `parentRunId` slot to associate the tool with the tracking node and
   * emit a `DarwinToolEvent` so consumers can build per-tool OTEL spans
   * or progress UIs.
   *
   * If `parentRunId` is missing OR the parent is not a tracked node, the
   * tool event is silently dropped — the handler never surfaces unmapped
   * activity (consistent with the chain-side `resolved.has(nodeName)` gate).
   */
  override handleToolStart(
    _tool: unknown,
    input: string,
    runId: string,
    parentRunId?: string,
    _tags?: string[],
    _metadata?: Record<string, unknown>,
    _runType?: string,
    name?: string,
  ): void {
    if (typeof parentRunId !== "string") return;
    const inFlight = this.runIdToName.get(parentRunId);
    if (!inFlight) return;
    const entry = this.resolved.get(inFlight.nodeName);
    if (!entry) return;
    const toolName =
      typeof name === "string" && name.length > 0 ? name : "<anonymous-tool>";

    // V0.4 (R1 P1-1 fix): cache the tool name keyed by tool runId so
    // `handleToolEnd` / `handleToolError` can recover it. The LangChain
    // tool-end signature does NOT carry the name reliably across versions.
    if (this.maxInFlightToolRuns !== Infinity && !this.toolRunIdToName.has(runId)) {
      if (this.toolRunIdToName.size >= this.maxInFlightToolRuns) {
        const oldest = this.toolRunIdToName.keys().next().value;
        if (oldest !== undefined) this.toolRunIdToName.delete(oldest);
      }
    }
    this.toolRunIdToName.set(runId, toolName);

    // V0.4 (R1 P1-4 fix): increment pending-tools counter on the chain
    // so `handleChainEnd` knows to defer trajectory dispatch.
    inFlight.pendingTools++;

    if (!this.onToolEvent) return;
    const event: DarwinToolEvent = {
      nodeName: inFlight.nodeName,
      agentName: entry.agentName,
      toolName,
      phase: "start",
      runId,
      parentRunId,
      ...(typeof input === "string" ? { input } : {}),
    };
    this.dispatchToolEvent(event);
  }

  /**
   * V0.4 (S1235) — tool-chain end event.
   */
  override handleToolEnd(
    output: unknown,
    runId: string,
    parentRunId?: string,
  ): void {
    if (typeof parentRunId !== "string") return;
    const inFlight = this.runIdToName.get(parentRunId);
    if (!inFlight) {
      // Pending-tools counter is gone with the chain — best-effort
      // cleanup of the tool-name cache only.
      this.toolRunIdToName.delete(runId);
      return;
    }
    const entry = this.resolved.get(inFlight.nodeName);
    if (!entry) {
      this.toolRunIdToName.delete(runId);
      return;
    }
    // V0.4 (R1 P1-1 fix): recover the tool name from the cache populated
    // at `handleToolStart`. Fall back to inspecting `output.name` for
    // adversarial cases where start was missed (eg LangChain version
    // mismatch). Both paths preserve the start/end name symmetry that
    // older revisions broke.
    let toolName = this.toolRunIdToName.get(runId);
    if (!toolName) {
      if (output && typeof output === "object" && "name" in output) {
        const n = (output as { name?: unknown }).name;
        if (typeof n === "string" && n.length > 0) toolName = n;
      }
      if (!toolName) toolName = "<anonymous-tool>";
    }
    this.toolRunIdToName.delete(runId);

    if (this.onToolEvent) {
      const event: DarwinToolEvent = {
        nodeName: inFlight.nodeName,
        agentName: entry.agentName,
        toolName,
        phase: "end",
        runId,
        parentRunId,
        output,
      };
      this.dispatchToolEvent(event);
    }

    // V0.4 (R1 P1-4 fix): decrement pending counter and drain the
    // deferred trajectory dispatch if this was the last tool AND
    // handleChainEnd had already fired.
    inFlight.pendingTools = Math.max(0, inFlight.pendingTools - 1);
    if (inFlight.finalized && inFlight.pendingTools === 0) {
      const dispatch = this.pendingTrajectoryDispatch.get(parentRunId);
      if (dispatch) {
        this.pendingTrajectoryDispatch.delete(parentRunId);
        dispatch();
      }
      this.runIdToName.delete(parentRunId);
    }
  }

  /**
   * V0.4 (S1235) — tool-chain error event.
   */
  override handleToolError(
    err: Error,
    runId: string,
    parentRunId?: string,
  ): void {
    if (typeof parentRunId !== "string") return;
    const inFlight = this.runIdToName.get(parentRunId);
    if (!inFlight) {
      this.toolRunIdToName.delete(runId);
      return;
    }
    const entry = this.resolved.get(inFlight.nodeName);
    if (!entry) {
      this.toolRunIdToName.delete(runId);
      return;
    }
    // V0.4 (R1 P1-1 fix): recover the tool name from the cache.
    const toolName = this.toolRunIdToName.get(runId) ?? "<anonymous-tool>";
    this.toolRunIdToName.delete(runId);

    if (this.onToolEvent) {
      const event: DarwinToolEvent = {
        nodeName: inFlight.nodeName,
        agentName: entry.agentName,
        toolName,
        phase: "error",
        runId,
        parentRunId,
        error: err instanceof Error ? err : new Error(String(err)),
      };
      this.dispatchToolEvent(event);
    }

    // V0.4 (R1 P1-4 fix): mirror the pending-count drain from handleToolEnd.
    inFlight.pendingTools = Math.max(0, inFlight.pendingTools - 1);
    if (inFlight.finalized && inFlight.pendingTools === 0) {
      const dispatch = this.pendingTrajectoryDispatch.get(parentRunId);
      if (dispatch) {
        this.pendingTrajectoryDispatch.delete(parentRunId);
        dispatch();
      }
      this.runIdToName.delete(parentRunId);
    }
  }

  private dispatchToolEvent(event: DarwinToolEvent): void {
    void Promise.resolve()
      .then(() => this.onToolEvent!(event))
      .catch((err) => this.swallowTool(err));
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

  private swallowTool(err: unknown): void {
    if (this.toolWarned) return;
    this.toolWarned = true;
    console.warn(
      `[darwin-langgraph] DarwinCallbackHandler.onToolEvent threw — swallowed. ` +
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
