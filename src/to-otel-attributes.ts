/**
 * Surface 5 (V0.2) — `toOtelAttributes(trajectory, opts?)`.
 *
 * Pure mapper from Darwin's `ExecutionTrace` to a flat
 * `Record<string, string | number | boolean>` keyed by
 * [OpenTelemetry GenAI Semantic Conventions](https://github.com/open-telemetry/semantic-conventions/blob/main/docs/gen-ai/gen-ai-spans.md)
 * attribute names — so any OTEL-compatible exporter (Langfuse,
 * Braintrust, Honeycomb, Datadog, New Relic, Grafana) picks up the
 * trace data without further mapping.
 *
 * Coverage:
 *   - `gen_ai.operation.name` = `"invoke_agent"` (constant per OTEL
 *     GenAI spec for agent-level operations).
 *   - `gen_ai.agent.name` = `opts.agentName` (callers passes the
 *     agent's logical name).
 *   - `gen_ai.agent.id` = `opts.agentId` (optional UUID/run id).
 *   - `gen_ai.usage.input_tokens` / `output_tokens` / `cache_read_tokens` /
 *     `cache_creation_tokens` — only emitted when the upstream
 *     trajectory captured token usage (i.e. provider reported it).
 *   - `darwin.trajectory.tool_calls.count` (custom, non-OTEL — namespaced
 *     under `darwin.*` to avoid colliding with future OTEL fields).
 *   - `darwin.trajectory.text_blocks` / `turns` / `mcp_invocations` /
 *     `errors.count` — same custom namespace.
 *   - `darwin.trajectory.captured_at` — ISO string for traceability.
 *
 * Per OTEL GenAI spec we DO NOT emit `gen_ai.tool.call.arguments` /
 * `gen_ai.tool.call.result` here — those are span-level attributes
 * meant to be attached to per-tool-call spans, not the aggregate
 * trajectory. Callers who need them should iterate `trajectory.toolCalls`
 * and emit one child span per call.
 *
 * Design notes:
 *   - **Sparse output.** Undefined fields stay out of the result rather
 *     than appearing as `null` — keeps OTEL exporters from over-counting
 *     missing-data buckets.
 *   - **No allocation on hot path.** The function builds a single
 *     object literal incrementally; no Map / Set / array intermediates.
 *   - **Pure.** No side effects, no I/O, no Date.now() — fully
 *     testable with deterministic inputs.
 */

import type { ExecutionTrace } from "darwin-agents";

/** Options accepted by {@link toOtelAttributes}. */
export interface ToOtelAttributesOptions {
  /** Logical agent name. Maps to `gen_ai.agent.name`. */
  agentName?: string;
  /** Optional agent id (e.g. uuid or experiment id). Maps to `gen_ai.agent.id`. */
  agentId?: string;
  /**
   * Custom namespace for Darwin-specific attributes that have no OTEL
   * equivalent. Default: `"darwin"` → emits `darwin.trajectory.*`.
   * Override for organisation-wide naming conventions (e.g. `"company.darwin"`).
   */
  customNamespace?: string;
}

/** Flat attribute bag matching OTEL's primitive-only attribute types. */
export type OtelAttributes = Record<string, string | number | boolean>;

/**
 * Build the OTEL attribute bag for an `ExecutionTrace`.
 *
 * @example
 * ```ts
 * import { toOtelAttributes } from "darwin-langgraph";
 *
 * const attrs = toOtelAttributes(event.trajectory, {
 *   agentName: event.agentName,
 *   agentId: someExperimentId,
 * });
 * // attrs = {
 * //   "gen_ai.operation.name": "invoke_agent",
 * //   "gen_ai.agent.name": "researcher",
 * //   "gen_ai.agent.id": "exp-2026-05-25-001",
 * //   "gen_ai.usage.input_tokens": 1200,
 * //   "gen_ai.usage.output_tokens": 340,
 * //   "darwin.trajectory.tool_calls.count": 3,
 * //   "darwin.trajectory.text_blocks": 2,
 * //   "darwin.trajectory.turns": 4,
 * //   "darwin.trajectory.mcp_invocations": 2,
 * //   "darwin.trajectory.errors.count": 0,
 * //   "darwin.trajectory.captured_at": "2026-05-25T08:00:00.000Z",
 * // }
 *
 * // OTEL exporter usage (any tracer):
 * span.setAttributes(attrs);
 * ```
 */
export function toOtelAttributes(
  trajectory: ExecutionTrace,
  opts: ToOtelAttributesOptions = {},
): OtelAttributes {
  if (!trajectory || typeof trajectory !== "object" || trajectory.version !== 1) {
    throw new TypeError(
      `toOtelAttributes: trajectory must be an ExecutionTrace with version=1, got ${
        trajectory === null ? "null" : typeof trajectory
      }`,
    );
  }

  const ns = opts.customNamespace ?? "darwin";

  const attrs: OtelAttributes = {
    // OTEL GenAI required-style attributes
    "gen_ai.operation.name": "invoke_agent",
  };

  if (opts.agentName) attrs["gen_ai.agent.name"] = opts.agentName;
  if (opts.agentId) attrs["gen_ai.agent.id"] = opts.agentId;

  // Token usage — only emit when provider reported FINITE numbers. NaN
  // and Infinity pass `typeof === "number"` but OTEL exporters drop
  // spans with non-finite numeric attrs silently (R1 V0.2 Critic
  // Finding 3 + Finding 7, S1185).
  //
  // OTEL GenAI spec attribute names (R1 V0.2 Research Finding 1, S1185):
  // cache fields are `gen_ai.usage.cache_read.input_tokens` /
  // `cache_creation.input_tokens` per the official registry, NOT the
  // shorter `cache_read_tokens` / `cache_creation_tokens` we had pre-fix.
  const usage = trajectory.tokenUsage;
  if (usage) {
    if (typeof usage.inputTokens === "number" && Number.isFinite(usage.inputTokens)) {
      attrs["gen_ai.usage.input_tokens"] = usage.inputTokens;
    }
    if (typeof usage.outputTokens === "number" && Number.isFinite(usage.outputTokens)) {
      attrs["gen_ai.usage.output_tokens"] = usage.outputTokens;
    }
    if (typeof usage.cacheReadTokens === "number" && Number.isFinite(usage.cacheReadTokens)) {
      attrs["gen_ai.usage.cache_read.input_tokens"] = usage.cacheReadTokens;
    }
    if (
      typeof usage.cacheCreationTokens === "number" &&
      Number.isFinite(usage.cacheCreationTokens)
    ) {
      attrs["gen_ai.usage.cache_creation.input_tokens"] = usage.cacheCreationTokens;
    }
  }

  // Darwin-namespaced aggregates (always emitted, even when 0, so
  // dashboards can graph deltas correctly). Defensive `?? 0` fallback
  // in case a future darwin-agents version makes a field optional.
  const toolCallsCount = Array.isArray(trajectory.toolCalls)
    ? trajectory.toolCalls.length
    : 0;
  const errorsCount = Array.isArray(trajectory.errors) ? trajectory.errors.length : 0;
  attrs[`${ns}.trajectory.tool_calls.count`] = toolCallsCount;
  attrs[`${ns}.trajectory.text_blocks`] =
    Number.isFinite(trajectory.textBlockCount) ? trajectory.textBlockCount : 0;
  attrs[`${ns}.trajectory.turns`] =
    Number.isFinite(trajectory.turnCount) ? trajectory.turnCount : 0;
  attrs[`${ns}.trajectory.mcp_invocations`] =
    Number.isFinite(trajectory.mcpInvocations) ? trajectory.mcpInvocations : 0;
  attrs[`${ns}.trajectory.errors.count`] = errorsCount;
  if (typeof trajectory.capturedAt === "string" && trajectory.capturedAt.length > 0) {
    attrs[`${ns}.trajectory.captured_at`] = trajectory.capturedAt;
  }

  return attrs;
}

/**
 * Build per-tool-call OTEL attributes for each entry in
 * `trajectory.toolCalls`. Use this to emit one child span per tool call
 * under the parent agent span.
 *
 * Coverage:
 *   - `gen_ai.operation.name` = `"execute_tool"` (OTEL spec).
 *   - `gen_ai.tool.name` (OTEL spec).
 *   - `gen_ai.tool.call.id` (OTEL spec).
 *   - `gen_ai.tool.type` = `"function"` (default for MCP + builtins).
 *   - `darwin.tool.outcome` = `"success" | "error"` (custom).
 *   - `darwin.tool.duration_ms` (custom).
 *   - `darwin.tool.turn` (custom).
 *   - `darwin.tool.is_mcp` (boolean, custom).
 *   - `gen_ai.tool.call.arguments` (JSON-stringified) — opt-in via
 *     `opts.includeArguments`. Per OTEL spec this is OPT-IN because args
 *     can contain sensitive data.
 *   - `gen_ai.tool.call.result` — opt-in via `opts.includeResults` for
 *     the same reason.
 *   - `error.type` = `trajectory.toolCalls[i].errorClass` (when outcome=error).
 */
export interface ToolCallOtelOptions {
  customNamespace?: string;
  /** Emit `gen_ai.tool.call.arguments` (OPT-IN, may contain PII). */
  includeArguments?: boolean;
  /** Emit `gen_ai.tool.call.result` (OPT-IN, may contain PII). */
  includeResults?: boolean;
}

export function toolCallToOtelAttributes(
  call: ExecutionTrace["toolCalls"][number],
  opts: ToolCallOtelOptions = {},
): OtelAttributes {
  const ns = opts.customNamespace ?? "darwin";
  // R1 V0.2 Research Finding 3 (S1185): per OTEL GenAI spec, `gen_ai.tool.type`
  // takes one of `function` (client-side, agent generates params),
  // `extension` (agent-side, calls external APIs), or `datastore`. MCP
  // tools execute server-side via the agent and call external APIs —
  // they map to `"extension"`, not `"function"`. We route on the
  // existing `mcp__` prefix heuristic.
  const isMcp = call.tool.startsWith("mcp__");
  const toolType = isMcp ? "extension" : "function";
  const attrs: OtelAttributes = {
    "gen_ai.operation.name": "execute_tool",
    "gen_ai.tool.name": call.tool,
    "gen_ai.tool.type": toolType,
    [`${ns}.tool.outcome`]: call.outcome,
    [`${ns}.tool.duration_ms`]: Number.isFinite(call.durationMs) ? call.durationMs : 0,
    [`${ns}.tool.turn`]: Number.isFinite(call.turn) ? call.turn : 0,
    [`${ns}.tool.is_mcp`]: isMcp,
  };
  // `call.id` is optional on TraceToolCall — only emit when present so
  // OTEL exporters don't see empty-string ids.
  if (typeof call.id === "string" && call.id.length > 0) {
    attrs["gen_ai.tool.call.id"] = call.id;
  }

  if (call.outcome === "error") {
    if (typeof call.errorClass === "string" && call.errorClass.length > 0) {
      attrs["error.type"] = call.errorClass;
    }
    if (typeof call.errorMessage === "string" && call.errorMessage.length > 0) {
      attrs[`${ns}.tool.error.message`] = call.errorMessage;
    }
  }
  if (typeof call.retryCount === "number" && call.retryCount > 0) {
    attrs[`${ns}.tool.retry_count`] = call.retryCount;
  }
  if (opts.includeArguments && call.args !== undefined) {
    try {
      attrs["gen_ai.tool.call.arguments"] = JSON.stringify(call.args);
    } catch {
      attrs["gen_ai.tool.call.arguments"] = "<unserialisable>";
    }
  }
  if (
    opts.includeResults &&
    typeof call.resultSummary === "string" &&
    call.resultSummary.length > 0
  ) {
    attrs["gen_ai.tool.call.result"] = call.resultSummary;
  }

  return attrs;
}
