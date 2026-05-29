/**
 * V0.4 regression tests — `toW3CTraceContext`.
 *
 * Coverage: spec-compliant 32-hex traceId / 16-hex spanId, hierarchical
 * mapping when parentRunId is present, traceFlags opt, all-zero
 * rejection, non-UUID rejection, idempotent format.
 */

import { describe, expect, it } from "vitest";

import { toW3CTraceContext } from "../src/to-w3c-trace-context.js";
import type { DarwinTrajectoryEvent } from "../src/with-darwin-evolution.js";
import type { ExecutionTrace } from "../src/types.js";

const trace: ExecutionTrace = {
  version: 1,
  toolCalls: [],
  textBlockCount: 0,
  turnCount: 1,
  mcpInvocations: 0,
  errors: [],
  capturedAt: "2026-05-29T00:00:00.000Z",
};

function event(opts: {
  runId?: string;
  parentRunId?: string;
}): DarwinTrajectoryEvent {
  return {
    nodeName: "research",
    agentName: "researcher",
    trajectory: trace,
    finalState: Object.freeze({}),
    ...(opts.runId !== undefined ? { runId: opts.runId } : {}),
    ...(opts.parentRunId !== undefined ? { parentRunId: opts.parentRunId } : {}),
  };
}

const W3C_REGEX = /^00-[0-9a-f]{32}-[0-9a-f]{16}-(00|01)$/;

describe("toW3CTraceContext — basics", () => {
  it("returns undefined when runId is missing", () => {
    const ctx = toW3CTraceContext(event({}));
    expect(ctx).toBeUndefined();
  });

  it("returns spec-compliant traceparent for top-level invoke (spanId from SECOND half — R1 P0-1 fix)", () => {
    // R1 P0-1 fix (S1235): when there is no parentRunId, spanId is the
    // SECOND 16 chars of the run hex so it is never a prefix of the
    // traceId (which is the full 32 chars). Several OTEL backends
    // reject self-parent-looking spans.
    const ctx = toW3CTraceContext(
      event({ runId: "11111111-2222-3333-4444-555555555555" }),
    );
    expect(ctx).toBeDefined();
    expect(ctx!.traceparent).toMatch(W3C_REGEX);
    expect(ctx!.traceparent).toBe(
      "00-11111111222233334444555555555555-4444555555555555-01",
    );
    expect(ctx!.traceId).toBe("11111111222233334444555555555555");
    expect(ctx!.spanId).toBe("4444555555555555");
    // Belt-and-suspenders: spanId is NOT a prefix of traceId.
    expect(ctx!.traceId.startsWith(ctx!.spanId)).toBe(false);
  });

  it("hierarchical mapping: traceId from parentRunId, spanId from runId", () => {
    const ctx = toW3CTraceContext(
      event({
        runId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        parentRunId: "11111111-2222-3333-4444-555555555555",
      }),
    );
    expect(ctx!.traceId).toBe("11111111222233334444555555555555");
    expect(ctx!.spanId).toBe("aaaaaaaabbbbcccc");
    expect(ctx!.traceparent).toBe(
      "00-11111111222233334444555555555555-aaaaaaaabbbbcccc-01",
    );
  });

  it("traceFlags defaults to '01' (sampled)", () => {
    const ctx = toW3CTraceContext(
      event({ runId: "11111111-2222-3333-4444-555555555555" }),
    );
    expect(ctx!.traceparent.endsWith("-01")).toBe(true);
  });

  it("traceFlags '00' opts out of sampling", () => {
    const ctx = toW3CTraceContext(
      event({ runId: "11111111-2222-3333-4444-555555555555" }),
      { traceFlags: "00" },
    );
    expect(ctx!.traceparent.endsWith("-00")).toBe(true);
  });
});

describe("toW3CTraceContext — rejection paths", () => {
  it("returns undefined for non-UUID runId (too short)", () => {
    const ctx = toW3CTraceContext(event({ runId: "short" }));
    expect(ctx).toBeUndefined();
  });

  it("returns undefined for non-hex runId", () => {
    const ctx = toW3CTraceContext(
      event({ runId: "ZZZZZZZZ-yyyy-xxxx-wwww-vvvvvvvvvvvv" }),
    );
    expect(ctx).toBeUndefined();
  });

  it("falls back to runId-only with second-half spanId when parentRunId is malformed", () => {
    const ctx = toW3CTraceContext(
      event({
        runId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        parentRunId: "garbage",
      }),
    );
    // R1 P0-1 fix: same as no-parent path — spanId from the SECOND
    // half so it is never a prefix of the traceId.
    expect(ctx!.traceId).toBe("aaaaaaaabbbbccccddddeeeeeeeeeeee");
    expect(ctx!.spanId).toBe("ddddeeeeeeeeeeee");
    expect(ctx!.traceId.startsWith(ctx!.spanId)).toBe(false);
  });

  it("returns undefined for all-zero traceId", () => {
    const ctx = toW3CTraceContext(
      event({ runId: "00000000-0000-0000-0000-000000000000" }),
    );
    expect(ctx).toBeUndefined();
  });

  it("returns undefined when stripped parentRunId is all-zero AND runId fallback also zero", () => {
    const ctx = toW3CTraceContext(
      event({
        runId: "00000000-0000-0000-0000-000000000000",
        parentRunId: "00000000-0000-0000-0000-000000000000",
      }),
    );
    expect(ctx).toBeUndefined();
  });

  it("lowercases uppercase UUID hex", () => {
    const ctx = toW3CTraceContext(
      event({ runId: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE" }),
    );
    expect(ctx!.traceId).toBe("aaaaaaaabbbbccccddddeeeeeeeeeeee");
    expect(ctx!.traceparent).toMatch(W3C_REGEX);
  });
});

describe("toW3CTraceContext — purity", () => {
  it("same input yields same output (deterministic)", () => {
    const e = event({
      runId: "11111111-2222-3333-4444-555555555555",
      parentRunId: "99999999-8888-7777-6666-aaaaaaaaaaaa",
    });
    const ctx1 = toW3CTraceContext(e);
    const ctx2 = toW3CTraceContext(e);
    expect(ctx1).toEqual(ctx2);
  });
});
