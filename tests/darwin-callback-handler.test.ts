/**
 * Tests for `DarwinCallbackHandler` (V0.2, LangChain-native replacement
 * for `withDarwinEvolution`).
 *
 * Covers:
 *   - validation (empty / missing nodeMap)
 *   - runId → runName tracking through handleChainStart + handleChainEnd
 *   - trajectory extraction from chain outputs
 *   - fire-and-forget swallow on hook errors
 *   - real LangGraph invoke + stream + streamMode != "values"
 *   - concurrent invokes (no double-fire)
 *   - inflight cleanup on handleChainError
 */

import { StateGraph } from "@langchain/langgraph";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDarwinNode } from "../src/create-darwin-node.js";
import { DarwinCallbackHandler } from "../src/darwin-callback-handler.js";
import { darwinAnnotation } from "../src/darwin-annotation.js";
import { DarwinEvolutionHookError } from "../src/errors.js";
import type { AgentDefinition, ExecutionTrace, RunResult } from "../src/types.js";

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
  capturedAt: "2026-05-25T08:00:00.000Z",
});

const result = (output: string, n = 0): RunResult => ({
  output,
  experiment: {
    id: `exp-${output}`,
    agentName: "mock",
    promptVersion: "v1.0.0",
    task: "t",
    taskType: "test",
    startedAt: "2026-05-25T08:00:00.000Z",
    completedAt: "2026-05-25T08:00:01.000Z",
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

function buildGraph() {
  const State = darwinAnnotation();
  return new StateGraph(State)
    .addNode("research", createDarwinNode(agent))
    .addEdge("__start__", "research")
    .compile();
}

describe("DarwinCallbackHandler — validation", () => {
  it("throws DarwinEvolutionHookError when nodeMap is missing", () => {
    expect(() =>
      new DarwinCallbackHandler(
        {} as Parameters<typeof DarwinCallbackHandler.prototype.constructor>[0],
      ),
    ).toThrow(DarwinEvolutionHookError);
  });

  it("throws when nodeMap is empty", () => {
    expect(() => new DarwinCallbackHandler({ nodeMap: {} })).toThrow(
      DarwinEvolutionHookError,
    );
  });

  it("throws when nodeMap entry has wrong shape", () => {
    expect(() =>
      new DarwinCallbackHandler({
        // @ts-expect-error testing runtime guard
        nodeMap: { research: { agentName: 1 } },
      }),
    ).toThrow(DarwinEvolutionHookError);
  });

  it("accepts bare string entries", () => {
    expect(
      () => new DarwinCallbackHandler({ nodeMap: { research: "researcher" } }),
    ).not.toThrow();
  });

  it("accepts explicit { agentName, trajectoryKey } entries", () => {
    expect(
      () =>
        new DarwinCallbackHandler({
          nodeMap: {
            research: { agentName: "researcher", trajectoryKey: "trace" },
          },
        }),
    ).not.toThrow();
  });
});

describe("DarwinCallbackHandler — chain event dispatch", () => {
  it("dispatches onTrajectory after a real graph.invoke()", async () => {
    mockRunAgent.mockResolvedValueOnce(result("hello", 4));
    const onTrajectory = vi.fn();
    const handler = new DarwinCallbackHandler({
      nodeMap: { research: "researcher" },
      onTrajectory,
    });
    const g = buildGraph();
    const r = await g.invoke({ task: "x" }, { callbacks: [handler] });
    // Hook is fire-and-forget — flush microtasks.
    await new Promise((resolve) => setImmediate(resolve));
    expect(onTrajectory).toHaveBeenCalledOnce();
    const evt = onTrajectory.mock.calls[0][0];
    expect(evt.nodeName).toBe("research");
    expect(evt.agentName).toBe("researcher");
    expect(evt.trajectory.textBlockCount).toBe(4);
    expect(Object.isFrozen(evt.finalState)).toBe(true);
    expect(r).toMatchObject({ output: "hello" });
  });

  it("works the same under graph.stream() with streamMode='values'", async () => {
    mockRunAgent.mockResolvedValueOnce(result("streamed", 2));
    const onTrajectory = vi.fn();
    const handler = new DarwinCallbackHandler({
      nodeMap: { research: "researcher" },
      onTrajectory,
    });
    const g = buildGraph();
    const stream = await g.stream(
      { task: "x" },
      { streamMode: "values", callbacks: [handler] },
    );
    for await (const _ of stream) {
      /* consume */
    }
    await new Promise((resolve) => setImmediate(resolve));
    expect(onTrajectory).toHaveBeenCalledOnce();
  });

  it("works under graph.stream() with streamMode='updates' too (no silent skip)", async () => {
    // This is the streamMode where withDarwinEvolution silently skipped.
    // DarwinCallbackHandler is stream-mode-agnostic.
    mockRunAgent.mockResolvedValueOnce(result("updates-streamed", 3));
    const onTrajectory = vi.fn();
    const handler = new DarwinCallbackHandler({
      nodeMap: { research: "researcher" },
      onTrajectory,
    });
    const g = buildGraph();
    const stream = await g.stream(
      { task: "x" },
      { streamMode: "updates", callbacks: [handler] },
    );
    for await (const _ of stream) {
      /* consume */
    }
    await new Promise((resolve) => setImmediate(resolve));
    expect(onTrajectory).toHaveBeenCalledOnce();
    expect(onTrajectory.mock.calls[0][0].trajectory.textBlockCount).toBe(3);
  });

  it("two concurrent invokes fire onTrajectory exactly twice (no race)", async () => {
    mockRunAgent
      .mockResolvedValueOnce(result("a", 1))
      .mockResolvedValueOnce(result("b", 2));
    const onTrajectory = vi.fn();
    const handler = new DarwinCallbackHandler({
      nodeMap: { research: "researcher" },
      onTrajectory,
    });
    const g = buildGraph();
    await Promise.all([
      g.invoke({ task: "x" }, { callbacks: [handler] }),
      g.invoke({ task: "y" }, { callbacks: [handler] }),
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(onTrajectory).toHaveBeenCalledTimes(2);
  });

  it("concurrent invokes stay ISOLATED — no cross-leak of trajectory/node (LangGraph 1.4.x ensureLangGraphConfig)", async () => {
    // Regression guard for LangGraph 1.4.4's concurrent-singleton isolation
    // fix: two parallel invokes must each receive THEIR OWN trajectory, never
    // a leaked sibling's. We give the two runs distinct trajectories (textBlock
    // 1 vs 2) and assert the dispatched events carry both, each correctly
    // mapped to the same node/agent — proving per-run isolation.
    mockRunAgent
      .mockResolvedValueOnce(result("a", 1))
      .mockResolvedValueOnce(result("b", 2));
    const events: Array<{ nodeName: string; agentName: string; n: number }> = [];
    const handler = new DarwinCallbackHandler({
      nodeMap: { research: "researcher" },
      onTrajectory: (evt) =>
        events.push({
          nodeName: evt.nodeName,
          agentName: evt.agentName,
          n: evt.trajectory.textBlockCount,
        }),
    });
    const g = buildGraph();
    await Promise.all([
      g.invoke({ task: "x" }, { callbacks: [handler] }),
      g.invoke({ task: "y" }, { callbacks: [handler] }),
    ]);
    await new Promise((resolve) => setImmediate(resolve));

    expect(events).toHaveLength(2);
    // Both events map to the correct node/agent (no node-name leak).
    expect(events.every((e) => e.nodeName === "research")).toBe(true);
    expect(events.every((e) => e.agentName === "researcher")).toBe(true);
    // The two DISTINCT trajectories both arrived (order-independent) — neither
    // run saw the other's trajectory.
    expect(events.map((e) => e.n).sort()).toEqual([1, 2]);
  });

  it("skips when trajectory is missing in chain outputs", async () => {
    // Use captureTrace:false so the node never writes the trajectory.
    mockRunAgent.mockResolvedValueOnce(result("hello"));
    const onTrajectory = vi.fn();
    const State = darwinAnnotation();
    const g = new StateGraph(State)
      .addNode("research", createDarwinNode(agent, { captureTrace: false }))
      .addEdge("__start__", "research")
      .compile();
    const handler = new DarwinCallbackHandler({
      nodeMap: { research: "researcher" },
      onTrajectory,
    });
    await g.invoke({ task: "x" }, { callbacks: [handler] });
    await new Promise((resolve) => setImmediate(resolve));
    expect(onTrajectory).not.toHaveBeenCalled();
  });

  it("skips when nodeMap does not include the node that emitted trajectory", async () => {
    mockRunAgent.mockResolvedValueOnce(result("hello", 1));
    const onTrajectory = vi.fn();
    const handler = new DarwinCallbackHandler({
      nodeMap: { other_node_name: "other" },
      onTrajectory,
    });
    const g = buildGraph();
    await g.invoke({ task: "x" }, { callbacks: [handler] });
    await new Promise((resolve) => setImmediate(resolve));
    expect(onTrajectory).not.toHaveBeenCalled();
  });
});

describe("DarwinCallbackHandler — error handling", () => {
  it("swallows onTrajectory errors and warns once across many invokes", async () => {
    mockRunAgent.mockResolvedValue(result("hello", 1));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onTrajectory = vi.fn(() => {
      throw new Error("hook boom");
    });
    const handler = new DarwinCallbackHandler({
      nodeMap: { research: "researcher" },
      onTrajectory,
    });
    const g = buildGraph();
    await g.invoke({ task: "x" }, { callbacks: [handler] });
    await g.invoke({ task: "y" }, { callbacks: [handler] });
    await g.invoke({ task: "z" }, { callbacks: [handler] });
    await new Promise((resolve) => setImmediate(resolve));
    expect(onTrajectory).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("cleans up in-flight tracking on chain error", () => {
    const handler = new DarwinCallbackHandler({
      nodeMap: { research: "researcher" },
      onTrajectory: () => {},
    });
    // Simulate chain start without end
    handler.handleChainStart(
      {} as never,
      {} as never,
      "run-1",
      undefined,
      undefined,
      undefined,
      "research",
    );
    expect(handler.getInFlightCount()).toBe(1);
    handler.handleChainError(new Error("boom"), "run-1");
    expect(handler.getInFlightCount()).toBe(0);
  });

  it("ignores chain starts for unknown nodes (no leak)", () => {
    const handler = new DarwinCallbackHandler({
      nodeMap: { research: "researcher" },
      onTrajectory: () => {},
    });
    handler.handleChainStart(
      {} as never,
      {} as never,
      "run-x",
      undefined,
      undefined,
      undefined,
      "unknown-node-name",
    );
    expect(handler.getInFlightCount()).toBe(0);
  });
});
