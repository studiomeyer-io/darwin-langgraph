/**
 * Tests for `toOtelAttributes` + `toolCallToOtelAttributes` (V0.2,
 * OTEL GenAI Semantic Conventions mapping).
 */

import { describe, expect, it } from "vitest";

import {
  toOtelAttributes,
  toolCallToOtelAttributes,
} from "../src/to-otel-attributes.js";
import type { ExecutionTrace, TraceToolCall } from "../src/types.js";

const baseTrace: ExecutionTrace = {
  version: 1,
  toolCalls: [],
  textBlockCount: 2,
  turnCount: 3,
  mcpInvocations: 1,
  errors: [],
  capturedAt: "2026-05-25T08:00:00.000Z",
};

describe("toOtelAttributes — base mapping", () => {
  it("emits gen_ai.operation.name as 'invoke_agent'", () => {
    const attrs = toOtelAttributes(baseTrace);
    expect(attrs["gen_ai.operation.name"]).toBe("invoke_agent");
  });

  it("emits agent name + id when supplied", () => {
    const attrs = toOtelAttributes(baseTrace, {
      agentName: "researcher",
      agentId: "exp-001",
    });
    expect(attrs["gen_ai.agent.name"]).toBe("researcher");
    expect(attrs["gen_ai.agent.id"]).toBe("exp-001");
  });

  it("emits Darwin-namespaced aggregates always (even when 0)", () => {
    const attrs = toOtelAttributes(baseTrace);
    expect(attrs["darwin.trajectory.tool_calls.count"]).toBe(0);
    expect(attrs["darwin.trajectory.text_blocks"]).toBe(2);
    expect(attrs["darwin.trajectory.turns"]).toBe(3);
    expect(attrs["darwin.trajectory.mcp_invocations"]).toBe(1);
    expect(attrs["darwin.trajectory.errors.count"]).toBe(0);
    expect(attrs["darwin.trajectory.captured_at"]).toBe("2026-05-25T08:00:00.000Z");
  });

  it("respects customNamespace for Darwin attributes", () => {
    const attrs = toOtelAttributes(baseTrace, { customNamespace: "company.darwin" });
    expect(attrs["company.darwin.trajectory.tool_calls.count"]).toBe(0);
    expect(attrs["darwin.trajectory.tool_calls.count"]).toBeUndefined();
  });
});

describe("toOtelAttributes — token usage (sparse)", () => {
  it("emits all four token fields when provider reports them", () => {
    const attrs = toOtelAttributes({
      ...baseTrace,
      tokenUsage: {
        inputTokens: 1200,
        outputTokens: 340,
        cacheReadTokens: 100,
        cacheCreationTokens: 50,
      },
    });
    expect(attrs["gen_ai.usage.input_tokens"]).toBe(1200);
    expect(attrs["gen_ai.usage.output_tokens"]).toBe(340);
    // R1 V0.2 Research Finding 1 (S1185): OTEL spec uses
    // `cache_read.input_tokens` and `cache_creation.input_tokens` per the
    // official attribute registry, not the shorter `cache_*_tokens` form.
    expect(attrs["gen_ai.usage.cache_read.input_tokens"]).toBe(100);
    expect(attrs["gen_ai.usage.cache_creation.input_tokens"]).toBe(50);
  });

  it("drops NaN / Infinity tokens silently (OTEL exporter compliance)", () => {
    const attrs = toOtelAttributes({
      ...baseTrace,
      tokenUsage: {
        inputTokens: NaN,
        outputTokens: Infinity,
        cacheReadTokens: 50,
      },
    });
    expect(attrs["gen_ai.usage.input_tokens"]).toBeUndefined();
    expect(attrs["gen_ai.usage.output_tokens"]).toBeUndefined();
    expect(attrs["gen_ai.usage.cache_read.input_tokens"]).toBe(50);
  });

  it("omits token fields when provider does not report them", () => {
    const attrs = toOtelAttributes(baseTrace); // no tokenUsage
    expect(attrs["gen_ai.usage.input_tokens"]).toBeUndefined();
    expect(attrs["gen_ai.usage.output_tokens"]).toBeUndefined();
  });

  it("emits only the fields the provider reported", () => {
    const attrs = toOtelAttributes({
      ...baseTrace,
      tokenUsage: { inputTokens: 100 },
    });
    expect(attrs["gen_ai.usage.input_tokens"]).toBe(100);
    expect(attrs["gen_ai.usage.output_tokens"]).toBeUndefined();
  });
});

describe("toOtelAttributes — invalid input", () => {
  it("throws TypeError on trajectory with wrong version", () => {
    expect(() =>
      toOtelAttributes({ ...baseTrace, version: 2 as unknown as 1 }),
    ).toThrow(TypeError);
  });

  it("throws TypeError on null trajectory", () => {
    expect(() =>
      toOtelAttributes(null as unknown as ExecutionTrace),
    ).toThrow(TypeError);
  });

  it("throws TypeError on undefined trajectory", () => {
    expect(() =>
      toOtelAttributes(undefined as unknown as ExecutionTrace),
    ).toThrow(TypeError);
  });
});

describe("toolCallToOtelAttributes — per-tool span attributes", () => {
  const baseCall: TraceToolCall = {
    id: "call_abc",
    tool: "mcp__nex__search",
    outcome: "success",
    durationMs: 150,
    turn: 1,
  };

  it("emits the OTEL-spec core fields", () => {
    const attrs = toolCallToOtelAttributes(baseCall);
    expect(attrs["gen_ai.operation.name"]).toBe("execute_tool");
    expect(attrs["gen_ai.tool.name"]).toBe("mcp__nex__search");
    expect(attrs["gen_ai.tool.call.id"]).toBe("call_abc");
    // R1 V0.2 Research Finding 3 (S1185): MCP tools execute server-side
    // and call external APIs — they map to OTEL "extension", not "function".
    expect(attrs["gen_ai.tool.type"]).toBe("extension");
  });

  it("uses 'function' tool.type for non-mcp__ builtin tools", () => {
    const attrs = toolCallToOtelAttributes({ ...baseCall, tool: "Read" });
    expect(attrs["gen_ai.tool.type"]).toBe("function");
  });

  it("emits Darwin-namespaced fields", () => {
    const attrs = toolCallToOtelAttributes(baseCall);
    expect(attrs["darwin.tool.outcome"]).toBe("success");
    expect(attrs["darwin.tool.duration_ms"]).toBe(150);
    expect(attrs["darwin.tool.turn"]).toBe(1);
    expect(attrs["darwin.tool.is_mcp"]).toBe(true);
  });

  it("is_mcp=false for builtin tools (no mcp__ prefix)", () => {
    const attrs = toolCallToOtelAttributes({ ...baseCall, tool: "Read" });
    expect(attrs["darwin.tool.is_mcp"]).toBe(false);
  });

  it("omits gen_ai.tool.call.id when id is missing", () => {
    const { id: _id, ...callNoId } = baseCall;
    const attrs = toolCallToOtelAttributes(callNoId as TraceToolCall);
    expect(attrs["gen_ai.tool.call.id"]).toBeUndefined();
  });

  it("emits error.type + error message on error outcome", () => {
    const attrs = toolCallToOtelAttributes({
      ...baseCall,
      outcome: "error",
      errorClass: "timeout",
      errorMessage: "took too long",
    });
    expect(attrs["error.type"]).toBe("timeout");
    expect(attrs["darwin.tool.error.message"]).toBe("took too long");
  });

  it("does NOT emit gen_ai.tool.call.arguments by default (PII opt-in)", () => {
    const attrs = toolCallToOtelAttributes({
      ...baseCall,
      args: { secret: "leak-me" },
    });
    expect(attrs["gen_ai.tool.call.arguments"]).toBeUndefined();
  });

  it("emits gen_ai.tool.call.arguments when explicitly opted-in", () => {
    const attrs = toolCallToOtelAttributes(
      { ...baseCall, args: { q: "foo" } },
      { includeArguments: true },
    );
    expect(attrs["gen_ai.tool.call.arguments"]).toBe('{"q":"foo"}');
  });

  it("handles unserialisable args gracefully", () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    const attrs = toolCallToOtelAttributes(
      { ...baseCall, args: circular },
      { includeArguments: true },
    );
    expect(attrs["gen_ai.tool.call.arguments"]).toBe("<unserialisable>");
  });

  it("emits gen_ai.tool.call.result when opted-in + present", () => {
    const attrs = toolCallToOtelAttributes(
      { ...baseCall, resultSummary: "3 hits" },
      { includeResults: true },
    );
    expect(attrs["gen_ai.tool.call.result"]).toBe("3 hits");
  });

  it("emits retry_count only when > 0", () => {
    const withZero = toolCallToOtelAttributes({ ...baseCall, retryCount: 0 });
    expect(withZero["darwin.tool.retry_count"]).toBeUndefined();
    const withTwo = toolCallToOtelAttributes({ ...baseCall, retryCount: 2 });
    expect(withTwo["darwin.tool.retry_count"]).toBe(2);
  });
});
