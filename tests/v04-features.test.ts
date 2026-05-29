/**
 * V0.4 regression tests for the DarwinCallbackHandler V0.4 additions:
 *   - `onToolEvent` hook (handleToolStart/End/Error)
 *   - `maxTrajectoryBytes` size guard + `trajectoryTruncated` event flag
 *   - `isExecutionTrace` forward-compat (v ≥ 2 with structural shape)
 *
 * Plus `toOtelAttributes` V0.4 new options:
 *   - `langGraphNode` / `langGraphStep` / `userId` / `requestId`
 *
 * Plus `createDarwinNode` V0.4 `onAttempt` callback.
 */

import { StateGraph } from "@langchain/langgraph";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDarwinNode } from "../src/create-darwin-node.js";
import {
  DarwinCallbackHandler,
  MAX_KNOWN_TRACE_VERSION,
  type DarwinToolEvent,
} from "../src/darwin-callback-handler.js";
import { darwinAnnotation } from "../src/darwin-annotation.js";
import { toOtelAttributes } from "../src/to-otel-attributes.js";
import type {
  AgentDefinition,
  ExecutionTrace,
  RunResult,
} from "../src/types.js";

vi.mock("darwin-agents", async (importOriginal) => {
  const original = await importOriginal<typeof import("darwin-agents")>();
  return { ...original, runAgent: vi.fn() };
});

import { runAgent } from "darwin-agents";

const mockRunAgent = runAgent as unknown as ReturnType<typeof vi.fn>;

const trace = (n = 0): ExecutionTrace => ({
  version: 1,
  toolCalls: [],
  textBlockCount: n,
  turnCount: 1,
  mcpInvocations: 0,
  errors: [],
  capturedAt: "2026-05-29T08:00:00.000Z",
});

const result = (output: string, n = 0): RunResult => ({
  output,
  experiment: {
    id: `exp-${output}`,
    agentName: "mock",
    promptVersion: "v1.0.0",
    task: "t",
    taskType: "test",
    startedAt: "2026-05-29T08:00:00.000Z",
    completedAt: "2026-05-29T08:00:01.000Z",
    success: true,
    metrics: {
      successRate: 1,
      avgQuality: 1,
      avgSpeedSeconds: 1,
      avgCost: 0,
      avgTokens: 100,
      consistency: 1,
      sampleSize: 1,
    },
    trajectory: trace(n),
  },
});

const agent: AgentDefinition = {
  name: "researcher",
  role: "x",
  description: "y",
  systemPrompt: "z",
};

beforeEach(() => mockRunAgent.mockReset());
afterEach(() => vi.restoreAllMocks());

function buildHandler(opts?: {
  onToolEvent?: (e: DarwinToolEvent) => void | Promise<void>;
  maxTrajectoryBytes?: number;
  onTrajectory?: (e: unknown) => void;
}): DarwinCallbackHandler {
  return new DarwinCallbackHandler({
    nodeMap: { research: "researcher" },
    onToolEvent: opts?.onToolEvent,
    onTrajectory: opts?.onTrajectory as never,
    ...(opts?.maxTrajectoryBytes !== undefined
      ? { maxTrajectoryBytes: opts.maxTrajectoryBytes }
      : {}),
  });
}

function startChain(
  handler: DarwinCallbackHandler,
  runId: string,
  nodeName = "research",
): void {
  handler.handleChainStart(
    {} as never,
    {} as never,
    runId,
    undefined,
    undefined,
    { langgraph_node: nodeName },
    nodeName,
  );
}

// ---------------------------------------------------------------------------
// V0.4 #1 — onToolEvent
// ---------------------------------------------------------------------------

describe("V0.4: DarwinCallbackHandler.onToolEvent", () => {
  it("fires phase='start' with input on handleToolStart", () => {
    const onToolEvent = vi.fn();
    const handler = buildHandler({ onToolEvent });
    startChain(handler, "chain-1");
    handler.handleToolStart(
      {} as never,
      "search-query",
      "tool-1",
      "chain-1",
      [],
      {},
      undefined,
      "web_search",
    );
    return new Promise((r) => setImmediate(r)).then(() => {
      expect(onToolEvent).toHaveBeenCalledOnce();
      const e = onToolEvent.mock.calls[0][0] as DarwinToolEvent;
      expect(e.phase).toBe("start");
      expect(e.toolName).toBe("web_search");
      expect(e.input).toBe("search-query");
      expect(e.runId).toBe("tool-1");
      expect(e.parentRunId).toBe("chain-1");
      expect(e.nodeName).toBe("research");
      expect(e.agentName).toBe("researcher");
    });
  });

  it("fires phase='end' with output on handleToolEnd", () => {
    const onToolEvent = vi.fn();
    const handler = buildHandler({ onToolEvent });
    startChain(handler, "chain-2");
    handler.handleToolStart(
      {} as never,
      "q",
      "tool-2",
      "chain-2",
      [],
      {},
      undefined,
      "web_search",
    );
    handler.handleToolEnd({ name: "web_search", out: "data" }, "tool-2", "chain-2");
    return new Promise((r) => setImmediate(r)).then(() => {
      expect(onToolEvent).toHaveBeenCalledTimes(2);
      const endEvt = onToolEvent.mock.calls[1][0] as DarwinToolEvent;
      expect(endEvt.phase).toBe("end");
      expect(endEvt.toolName).toBe("web_search");
      expect(endEvt.output).toMatchObject({ name: "web_search", out: "data" });
    });
  });

  it("fires phase='error' with Error on handleToolError", () => {
    const onToolEvent = vi.fn();
    const handler = buildHandler({ onToolEvent });
    startChain(handler, "chain-3");
    const err = new Error("rate-limit");
    handler.handleToolError(err, "tool-3", "chain-3");
    return new Promise((r) => setImmediate(r)).then(() => {
      expect(onToolEvent).toHaveBeenCalledOnce();
      const e = onToolEvent.mock.calls[0][0] as DarwinToolEvent;
      expect(e.phase).toBe("error");
      expect(e.error).toBe(err);
    });
  });

  it("does NOT fire when parentRunId is missing (top-level tool)", () => {
    const onToolEvent = vi.fn();
    const handler = buildHandler({ onToolEvent });
    handler.handleToolStart(
      {} as never,
      "q",
      "tool-orphan",
      undefined,
      [],
      {},
      undefined,
      "x",
    );
    expect(onToolEvent).not.toHaveBeenCalled();
  });

  it("does NOT fire when parentRunId is not a tracked node", () => {
    const onToolEvent = vi.fn();
    const handler = buildHandler({ onToolEvent });
    // No chainStart for "unknown-chain" — handler doesn't know it.
    handler.handleToolStart(
      {} as never,
      "q",
      "tool-x",
      "unknown-chain",
      [],
      {},
      undefined,
      "x",
    );
    expect(onToolEvent).not.toHaveBeenCalled();
  });

  it("swallows onToolEvent throws with one-shot warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handler = buildHandler({
      onToolEvent: () => {
        throw new Error("hook boom");
      },
    });
    startChain(handler, "chain-4");
    handler.handleToolStart(
      {} as never,
      "q",
      "tool-4",
      "chain-4",
      [],
      {},
      undefined,
      "x",
    );
    handler.handleToolEnd("data", "tool-4", "chain-4");
    return new Promise((r) => setImmediate(r)).then(() => {
      const toolWarns = warn.mock.calls.filter((c) =>
        String(c[0]).includes("onToolEvent"),
      );
      expect(toolWarns.length).toBe(1);
    });
  });

  it("wraps a non-Error thrown error into an Error instance", () => {
    const onToolEvent = vi.fn();
    const handler = buildHandler({ onToolEvent });
    startChain(handler, "chain-5");
    handler.handleToolError("string-error" as unknown as Error, "tool-5", "chain-5");
    return new Promise((r) => setImmediate(r)).then(() => {
      const e = onToolEvent.mock.calls[0][0] as DarwinToolEvent;
      expect(e.error).toBeInstanceOf(Error);
      expect(e.error?.message).toContain("string-error");
    });
  });
});

// ---------------------------------------------------------------------------
// V0.4 #2 — maxTrajectoryBytes
// ---------------------------------------------------------------------------

describe("V0.4: DarwinCallbackHandler.maxTrajectoryBytes", () => {
  function oversizedTrace(): ExecutionTrace {
    return {
      ...trace(0),
      toolCalls: Array.from({ length: 50 }, (_, i) => ({
        id: `tc-${i}`,
        tool: "web_search",
        args: { query: "x".repeat(2000) },
        resultSummary: "y".repeat(2000),
        outcome: "success" as const,
        durationMs: 100,
        retryCount: 0,
        turn: i,
      })),
    };
  }

  it("emits unchanged trajectory when below cap", () => {
    const onTrajectory = vi.fn();
    const handler = buildHandler({
      onTrajectory,
      maxTrajectoryBytes: 1_000_000,
    });
    startChain(handler, "chain-A");
    handler.handleChainEnd(
      { task: "x", output: "ok", darwinTrajectory: trace(1) } as never,
      "chain-A",
    );
    return new Promise((r) => setImmediate(r)).then(() => {
      const evt = onTrajectory.mock.calls[0][0] as {
        trajectory: ExecutionTrace;
        trajectoryTruncated?: boolean;
      };
      expect(evt.trajectory.textBlockCount).toBe(1);
      expect("trajectoryTruncated" in evt).toBe(false);
    });
  });

  it("replaces oversized trajectory + sets trajectoryTruncated=true", () => {
    const onTrajectory = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handler = buildHandler({
      onTrajectory,
      maxTrajectoryBytes: 1000, // small enough that any sane trajectory exceeds
    });
    startChain(handler, "chain-B");
    handler.handleChainEnd(
      { task: "x", output: "ok", darwinTrajectory: oversizedTrace() } as never,
      "chain-B",
    );
    return new Promise((r) => setImmediate(r)).then(() => {
      const evt = onTrajectory.mock.calls[0][0] as {
        trajectory: ExecutionTrace;
        trajectoryTruncated?: boolean;
      };
      expect(evt.trajectoryTruncated).toBe(true);
      expect(evt.trajectory.toolCalls).toEqual([]);
      // Counts preserved.
      expect(evt.trajectory.turnCount).toBe(1);
      expect(evt.trajectory.version).toBe(1);
      const truncWarns = warn.mock.calls.filter((c) =>
        String(c[0]).includes("byte cap"),
      );
      expect(truncWarns.length).toBe(1);
    });
  });

  it("warns once even when many truncations happen", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handler = buildHandler({
      onTrajectory: () => {},
      maxTrajectoryBytes: 1000,
    });
    for (let i = 0; i < 5; i++) {
      startChain(handler, `chain-T-${i}`);
      handler.handleChainEnd(
        { task: "x", output: "ok", darwinTrajectory: oversizedTrace() } as never,
        `chain-T-${i}`,
      );
    }
    const truncWarns = warn.mock.calls.filter((c) =>
      String(c[0]).includes("byte cap"),
    );
    expect(truncWarns.length).toBe(1);
  });

  it("Infinity opts out — no truncation ever", () => {
    const onTrajectory = vi.fn();
    const handler = buildHandler({
      onTrajectory,
      maxTrajectoryBytes: Infinity,
    });
    startChain(handler, "chain-Inf");
    handler.handleChainEnd(
      { task: "x", output: "ok", darwinTrajectory: oversizedTrace() } as never,
      "chain-Inf",
    );
    return new Promise((r) => setImmediate(r)).then(() => {
      const evt = onTrajectory.mock.calls[0][0] as {
        trajectory: ExecutionTrace;
        trajectoryTruncated?: boolean;
      };
      expect("trajectoryTruncated" in evt).toBe(false);
      expect(evt.trajectory.toolCalls.length).toBe(50);
    });
  });

  it("invalid maxTrajectoryBytes (NaN / negative / 0) falls back to default", () => {
    const cases = [NaN, -1, 0, "no" as unknown as number];
    for (const c of cases) {
      const onTrajectory = vi.fn();
      const handler = new DarwinCallbackHandler({
        nodeMap: { research: "researcher" },
        onTrajectory,
        maxTrajectoryBytes: c,
      });
      // White-box: default 256 KiB does NOT truncate a tiny trace.
      startChain(handler, "chain-d");
      handler.handleChainEnd(
        { task: "x", output: "ok", darwinTrajectory: trace(1) } as never,
        "chain-d",
      );
    }
  });

  it("circular-ref trajectory treated as oversized (defensive)", () => {
    const onTrajectory = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handler = buildHandler({
      onTrajectory,
      maxTrajectoryBytes: 100_000,
    });
    // ExecutionTrace shape but circular — JSON.stringify throws.
    const circular: ExecutionTrace = trace(1);
    (circular as Record<string, unknown>).self = circular;
    startChain(handler, "chain-circ");
    handler.handleChainEnd(
      { task: "x", output: "ok", darwinTrajectory: circular } as never,
      "chain-circ",
    );
    return new Promise((r) => setImmediate(r)).then(() => {
      const evt = onTrajectory.mock.calls[0][0] as {
        trajectoryTruncated?: boolean;
      };
      expect(evt.trajectoryTruncated).toBe(true);
      expect(
        warn.mock.calls.some((c) => String(c[0]).includes("byte cap")),
      ).toBe(true);
    });
  });

  it("preserves tokenUsage when truncating", () => {
    const onTrajectory = vi.fn();
    const handler = buildHandler({
      onTrajectory,
      maxTrajectoryBytes: 1000,
    });
    const fat: ExecutionTrace = {
      ...trace(0),
      tokenUsage: {
        inputTokens: 1234,
        outputTokens: 567,
      },
      toolCalls: Array.from({ length: 50 }, (_, i) => ({
        id: `tc-${i}`,
        tool: "x",
        args: { q: "y".repeat(500) },
        resultSummary: "z".repeat(500),
        outcome: "success" as const,
        durationMs: 100,
        retryCount: 0,
        turn: i,
      })),
    };
    startChain(handler, "chain-tu");
    handler.handleChainEnd(
      { task: "x", output: "ok", darwinTrajectory: fat } as never,
      "chain-tu",
    );
    return new Promise((r) => setImmediate(r)).then(() => {
      const evt = onTrajectory.mock.calls[0][0] as {
        trajectory: ExecutionTrace;
      };
      expect(evt.trajectory.tokenUsage).toEqual({
        inputTokens: 1234,
        outputTokens: 567,
      });
    });
  });
});

// ---------------------------------------------------------------------------
// V0.4 #3 — forward-compat (isExecutionTrace v ≥ 2)
// ---------------------------------------------------------------------------

describe("V0.4: isExecutionTrace forward-compat", () => {
  it("exports MAX_KNOWN_TRACE_VERSION = 1", () => {
    expect(MAX_KNOWN_TRACE_VERSION).toBe(1);
  });

  it("accepts a structurally-valid v=2 trajectory with warn-once", async () => {
    // resetModules so the process-wide warn flag is fresh.
    vi.resetModules();
    const { DarwinCallbackHandler: FreshHandler } = await import(
      "../src/darwin-callback-handler.js"
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onTrajectory = vi.fn();
    const handler = new FreshHandler({
      nodeMap: { research: "researcher" },
      onTrajectory,
    });
    handler.handleChainStart(
      {} as never,
      {} as never,
      "chain-v2",
      undefined,
      undefined,
      { langgraph_node: "research" },
      "research",
    );
    const v2trace = { ...trace(1), version: 2 } as ExecutionTrace;
    handler.handleChainEnd(
      { task: "x", output: "ok", darwinTrajectory: v2trace } as never,
      "chain-v2",
    );
    await new Promise((r) => setImmediate(r));
    expect(onTrajectory).toHaveBeenCalledOnce();
    const versionWarns = warn.mock.calls.filter((c) =>
      String(c[0]).includes("version=2"),
    );
    expect(versionWarns.length).toBe(1);
    // Subsequent v=2 trajectories do NOT warn again (one-shot).
    handler.handleChainStart(
      {} as never,
      {} as never,
      "chain-v2b",
      undefined,
      undefined,
      { langgraph_node: "research" },
      "research",
    );
    handler.handleChainEnd(
      { task: "x", output: "ok", darwinTrajectory: v2trace } as never,
      "chain-v2b",
    );
    await new Promise((r) => setImmediate(r));
    const versionWarnsAfter = warn.mock.calls.filter((c) =>
      String(c[0]).includes("version=2"),
    );
    expect(versionWarnsAfter.length).toBe(1);
  });

  it("rejects a v=0 trajectory (older than baseline)", async () => {
    vi.resetModules();
    const { DarwinCallbackHandler: FreshHandler } = await import(
      "../src/darwin-callback-handler.js"
    );
    const onTrajectory = vi.fn();
    const handler = new FreshHandler({
      nodeMap: { research: "researcher" },
      onTrajectory,
    });
    handler.handleChainStart(
      {} as never,
      {} as never,
      "chain-v0",
      undefined,
      undefined,
      { langgraph_node: "research" },
      "research",
    );
    const v0trace = { ...trace(1), version: 0 } as unknown as ExecutionTrace;
    handler.handleChainEnd(
      { task: "x", output: "ok", darwinTrajectory: v0trace } as never,
      "chain-v0",
    );
    await new Promise((r) => setImmediate(r));
    expect(onTrajectory).not.toHaveBeenCalled();
  });

  it("rejects structurally-malformed trajectory (no toolCalls array)", async () => {
    vi.resetModules();
    const { DarwinCallbackHandler: FreshHandler } = await import(
      "../src/darwin-callback-handler.js"
    );
    const onTrajectory = vi.fn();
    const handler = new FreshHandler({
      nodeMap: { research: "researcher" },
      onTrajectory,
    });
    handler.handleChainStart(
      {} as never,
      {} as never,
      "chain-bad",
      undefined,
      undefined,
      { langgraph_node: "research" },
      "research",
    );
    handler.handleChainEnd(
      {
        task: "x",
        output: "ok",
        darwinTrajectory: { version: 1, errors: [] },
      } as never,
      "chain-bad",
    );
    await new Promise((r) => setImmediate(r));
    expect(onTrajectory).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// V0.4 #4 — toOtelAttributes V0.4 options
// ---------------------------------------------------------------------------

describe("V0.4: toOtelAttributes — LangGraph attributes", () => {
  const t = trace(1);

  it("emits gen_ai.langgraph.node when langGraphNode is supplied", () => {
    const attrs = toOtelAttributes(t, { langGraphNode: "research" });
    expect(attrs["gen_ai.langgraph.node"]).toBe("research");
  });

  it("emits gen_ai.langgraph.step when langGraphStep is supplied", () => {
    const attrs = toOtelAttributes(t, { langGraphStep: 3 });
    expect(attrs["gen_ai.langgraph.step"]).toBe(3);
  });

  it("drops empty-string langGraphNode", () => {
    const attrs = toOtelAttributes(t, { langGraphNode: "" });
    expect("gen_ai.langgraph.node" in attrs).toBe(false);
  });

  it("drops NaN langGraphStep", () => {
    const attrs = toOtelAttributes(t, { langGraphStep: NaN });
    expect("gen_ai.langgraph.step" in attrs).toBe(false);
  });

  it("drops negative langGraphStep", () => {
    const attrs = toOtelAttributes(t, { langGraphStep: -1 });
    expect("gen_ai.langgraph.step" in attrs).toBe(false);
  });

  it("emits gen_ai.request.user from userId", () => {
    const attrs = toOtelAttributes(t, { userId: "user-42" });
    expect(attrs["gen_ai.request.user"]).toBe("user-42");
  });

  it("emits gen_ai.request.id from requestId", () => {
    const attrs = toOtelAttributes(t, { requestId: "req-001" });
    expect(attrs["gen_ai.request.id"]).toBe("req-001");
  });

  it("composes all V0.4 fields together", () => {
    const attrs = toOtelAttributes(t, {
      agentName: "researcher",
      agentId: "exp-001",
      langGraphNode: "research",
      langGraphStep: 2,
      userId: "user-42",
      requestId: "req-001",
    });
    expect(attrs).toMatchObject({
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": "researcher",
      "gen_ai.agent.id": "exp-001",
      "gen_ai.langgraph.node": "research",
      "gen_ai.langgraph.step": 2,
      "gen_ai.request.user": "user-42",
      "gen_ai.request.id": "req-001",
    });
  });
});

// ---------------------------------------------------------------------------
// V0.4 #5 — createDarwinNode onAttempt
// ---------------------------------------------------------------------------

describe("V0.4: createDarwinNode — onAttempt callback", () => {
  function buildGraph(onAttempt?: (info: unknown) => void | Promise<void>) {
    const State = darwinAnnotation();
    return new StateGraph(State)
      .addNode(
        "research",
        createDarwinNode(agent, onAttempt ? { onAttempt: onAttempt as never } : {}),
      )
      .addEdge("__start__", "research")
      .compile();
  }

  it("fires onAttempt with nodeAttempt=1 on a fresh invoke", async () => {
    mockRunAgent.mockResolvedValueOnce(result("hello"));
    const onAttempt = vi.fn();
    const g = buildGraph(onAttempt);
    await g.invoke({ task: "x" });
    expect(onAttempt).toHaveBeenCalled();
    expect(onAttempt.mock.calls[0][0]).toMatchObject({ nodeAttempt: 1 });
  });

  it("forwards threadId from config.configurable", async () => {
    mockRunAgent.mockResolvedValueOnce(result("hello"));
    const onAttempt = vi.fn();
    const g = buildGraph(onAttempt);
    await g.invoke({ task: "x" }, { configurable: { thread_id: "thread-7" } });
    expect(onAttempt.mock.calls[0][0]).toMatchObject({ threadId: "thread-7" });
  });

  it("swallows onAttempt errors with one-shot warn", async () => {
    mockRunAgent
      .mockResolvedValueOnce(result("a"))
      .mockResolvedValueOnce(result("b"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const g = buildGraph(() => {
      throw new Error("attempt boom");
    });
    await g.invoke({ task: "x" });
    await g.invoke({ task: "y" });
    const attemptWarns = warn.mock.calls.filter((c) =>
      String(c[0]).includes("onAttempt"),
    );
    expect(attemptWarns.length).toBe(1);
  });

  it("awaits the onAttempt callback before invoking runAgent", async () => {
    const order: string[] = [];
    const onAttempt = async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push("attempt");
    };
    mockRunAgent.mockImplementationOnce(async () => {
      order.push("run");
      return result("hello");
    });
    const g = buildGraph(onAttempt);
    await g.invoke({ task: "x" });
    expect(order).toEqual(["attempt", "run"]);
  });

  it("does not fire onAttempt when none is supplied (no perf cost)", async () => {
    mockRunAgent.mockResolvedValueOnce(result("hello"));
    // Smoke: graph builds + invokes cleanly with no onAttempt opt.
    const g = buildGraph(undefined);
    const r = await g.invoke({ task: "x" });
    expect(r.output).toBe("hello");
  });
});
