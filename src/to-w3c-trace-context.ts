/**
 * Surface 11 (V0.4) — `toW3CTraceContext(event, opts?)`.
 *
 * Pure mapper from a {@link DarwinTrajectoryEvent} to the
 * [W3C Trace Context](https://www.w3.org/TR/trace-context/) `traceparent`
 * header format so consumers can propagate Darwin trajectories into
 * external systems (Langfuse, Honeycomb, Datadog APM, Tempo) without
 * pulling in `@opentelemetry/api` as a dependency.
 *
 * Format reference (spec §3.2.2):
 *
 *   traceparent = version "-" trace-id "-" parent-id "-" trace-flags
 *
 * - `version` = `"00"` (we emit only the current spec version).
 * - `trace-id` = 32 hex chars. We map LangChain's UUID `parentRunId` (if
 *   present) by stripping dashes — UUID is 32 hex chars + 4 dashes — so
 *   the strip yields exactly 32 chars. If `parentRunId` is undefined we
 *   fall back to `runId` (top-level invokes form their own trace).
 * - `parent-id` = 16 hex chars. We map LangChain's UUID `runId` by
 *   stripping dashes and TAKING THE FIRST 16 chars (parent-id is shorter
 *   than trace-id by spec design — first 16 chars of a UUID are random
 *   enough that collision probability per-trace is negligible).
 * - `trace-flags` = `"01"` (sampled). We always emit sampled — consumers
 *   that want head-based sampling should drop the entire event upstream
 *   rather than fiddle with the flag.
 *
 * The W3C spec forbids `trace-id == "00000000000000000000000000000000"`
 * and `parent-id == "0000000000000000"`. If either UUID strips to those
 * all-zero strings we return `undefined` rather than emit an invalid
 * header that downstream parsers reject.
 *
 * **Pure, no I/O, no allocation surprises.** The function builds a single
 * string. Safe to call inside `onTrajectory` hot paths.
 *
 * NEW V0.4 (S1235).
 */

import type { DarwinTrajectoryEvent } from "./with-darwin-evolution.js";

/** Options accepted by {@link toW3CTraceContext}. */
export interface ToW3CTraceContextOptions {
  /**
   * Override the trace-flags byte. Default `"01"` (sampled). Set `"00"`
   * for not-sampled — consumers can use this to mark trajectories that
   * would otherwise be sampled out before they reach the W3C-aware
   * exporter.
   */
  traceFlags?: "00" | "01";
}

/** Return shape: a single W3C-compliant `traceparent` header value. */
export interface W3CTraceContext {
  /** Full `traceparent` header value (spec §3.2). */
  traceparent: string;
  /** 32-hex trace ID — convenience accessor. */
  traceId: string;
  /** 16-hex span ID (the W3C `parent-id` slot) — convenience accessor. */
  spanId: string;
}

const ZERO_TRACE_ID = "00000000000000000000000000000000";
const ZERO_SPAN_ID = "0000000000000000";

function uuidToHex(uuid: string): string {
  // UUIDs are case-insensitive hex; lowercase to match the W3C spec.
  return uuid.replace(/-/g, "").toLowerCase();
}

function isPureHex(s: string): boolean {
  // Cheap test — characters 0-9, a-f. ASCII range check is faster than
  // a regex on hot paths.
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const isDigit = c >= 48 && c <= 57; // 0-9
    const isLowerHex = c >= 97 && c <= 102; // a-f
    if (!isDigit && !isLowerHex) return false;
  }
  return true;
}

/**
 * Convert a {@link DarwinTrajectoryEvent} into a W3C `traceparent` header
 * value. Returns `undefined` when no usable runId is present or when the
 * stripped UUIDs collapse to the all-zero strings the spec forbids.
 *
 * @example
 * ```ts
 * import { toW3CTraceContext, DarwinCallbackHandler } from "darwin-langgraph";
 *
 * const handler = new DarwinCallbackHandler({
 *   nodeMap: { research: "researcher" },
 *   onTrajectory: async (event) => {
 *     const ctx = toW3CTraceContext(event);
 *     if (!ctx) return;
 *     await fetch("https://langfuse.example/api/traces", {
 *       method: "POST",
 *       headers: { traceparent: ctx.traceparent },
 *       body: JSON.stringify({ trace: event.trajectory }),
 *     });
 *   },
 * });
 * ```
 */
export function toW3CTraceContext(
  event: DarwinTrajectoryEvent,
  opts: ToW3CTraceContextOptions = {},
): W3CTraceContext | undefined {
  if (!event.runId) return undefined;

  const runHex = uuidToHex(event.runId);
  // The W3C spec is strict about character set and length. If callers
  // pass a non-UUID runId (e.g. from a custom run identifier scheme)
  // bail out rather than emit a malformed header.
  if (runHex.length < 32 || !isPureHex(runHex)) return undefined;

  let traceIdSource: string;
  let spanFromFirstHalf: boolean;
  if (event.parentRunId) {
    const parentHex = uuidToHex(event.parentRunId);
    if (parentHex.length < 32 || !isPureHex(parentHex)) {
      // Parent is malformed — fall through to runId-only trace. In that
      // case we MUST domain-separate the spanId from the traceId; see
      // the no-parent branch comment below.
      traceIdSource = runHex;
      spanFromFirstHalf = false;
    } else {
      // Hierarchical: trace-id from parent, span-id from runId. The
      // first 16 hex of the runId are random in v4 / v7 UUIDs (variant
      // bits live at char 16+), so collision probability per trace is
      // negligible.
      traceIdSource = parentHex;
      spanFromFirstHalf = true;
    }
  } else {
    // Top-level invoke: when there is no separate parentRunId, deriving
    // BOTH traceId AND spanId from the FIRST 16 chars of the same UUID
    // produces a `traceparent` where the spanId is a prefix of the
    // traceId. Several OTEL backends (Datadog APM, Honeycomb classic)
    // reject or misroute such spans because they look like self-parents.
    // R1 P0-1 fix (S1235): take the SECOND half of the run hex for the
    // spanId so the two slots are domain-separated even when sourced
    // from the same UUID.
    traceIdSource = runHex;
    spanFromFirstHalf = false;
  }

  const traceId = traceIdSource.slice(0, 32);
  const spanId = spanFromFirstHalf
    ? runHex.slice(0, 16)
    : runHex.slice(16, 32);

  // Spec §3.2.2.2: trace-id == 0...0 is invalid. Same for parent-id.
  if (traceId === ZERO_TRACE_ID || spanId === ZERO_SPAN_ID) {
    return undefined;
  }

  const traceFlags = opts.traceFlags ?? "01";
  return {
    traceparent: `00-${traceId}-${spanId}-${traceFlags}`,
    traceId,
    spanId,
  };
}
