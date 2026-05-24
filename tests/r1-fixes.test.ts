/**
 * Regression tests for the R1 3-Agent-Code-Review findings (S1185).
 *
 * Covers:
 *   - Critic Finding 1: concurrent invoke() must fire onTrajectory exactly
 *     once per call (no double-fire from the wrapped stream that invoke
 *     consumes internally).
 *   - Critic Finding 2: stream() with streamMode != "values" warns once
 *     about silent hook-skip.
 *   - Critic Finding 6: result.experiment.trajectory === null path.
 *   - Research Finding 5: GraphInterrupt thrown from inside runAgent
 *     must be re-thrown un-wrapped so LangGraph HITL works.
 *   - Research Finding 8 (overlaps Critic 1): concurrent-invoke test.
 */

import { StateGraph } from "@langchain/langgraph";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDarwinNode } from "../src/create-darwin-node.js";
import { darwinAnnotation } from "../src/darwin-annotation.js";
import { DarwinNodeError } from "../src/errors.js";
import { withDarwinEvolution } from "../src/with-darwin-evolution.js";
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
  capturedAt: "2026-05-24T20:00:00.000Z",
});

const result = (output: string, n = 0): RunResult => ({
  output,
  experiment: {
    id: `exp-${output}`,
    agentName: "mock",
    promptVersion: "v1.0.0",
    task: "t",
    taskType: "test",
    startedAt: "2026-05-24T20:00:00.000Z",
    completedAt: "2026-05-24T20:00:01.000Z",
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

beforeEach(() => {
  mockRunAgent.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

function buildGraph() {
  const State = darwinAnnotation();
  return new StateGraph(State)
    .addNode("research", createDarwinNode(agent))
    .addEdge("__start__", "research")
    .compile();
}

describe("R1 Critic Finding 1 / Research 8 — concurrent invoke must not double-fire", () => {
  it("two concurrent invoke() calls fire onTrajectory exactly twice total", async () => {
    mockRunAgent
      .mockResolvedValueOnce(result("a", 1))
      .mockResolvedValueOnce(result("b", 2));
    const onTrajectory = vi.fn();
    const graph = withDarwinEvolution(buildGraph(), {
      nodeMap: { research: "researcher" },
      onTrajectory,
    });

    await Promise.all([graph.invoke({ task: "x" }), graph.invoke({ task: "y" })]);
    await new Promise((r) => setImmediate(r));

    // 2 invokes → 2 trajectories, never 3 or 4 (would mean double-fire from
    // wrapped stream + wrapped invoke).
    expect(onTrajectory).toHaveBeenCalledTimes(2);
    const tracesSeen = onTrajectory.mock.calls
      .map((c) => c[0].trajectory.textBlockCount)
      .sort();
    expect(tracesSeen).toEqual([1, 2]);
  });

  it("five concurrent invoke() calls each fire exactly once", async () => {
    for (let i = 0; i < 5; i++) {
      mockRunAgent.mockResolvedValueOnce(result(`${i}`, i));
    }
    const onTrajectory = vi.fn();
    const graph = withDarwinEvolution(buildGraph(), {
      nodeMap: { research: "researcher" },
      onTrajectory,
    });

    await Promise.all(
      Array.from({ length: 5 }, (_, i) => graph.invoke({ task: `task-${i}` })),
    );
    await new Promise((r) => setImmediate(r));

    expect(onTrajectory).toHaveBeenCalledTimes(5);
  });
});

describe("R1 Critic Finding 2 — non-values streamMode warns once", () => {
  it("warns once when streamMode is 'updates'", async () => {
    mockRunAgent.mockResolvedValue(result("x"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const graph = withDarwinEvolution(buildGraph(), {
      nodeMap: { research: "researcher" },
      onTrajectory: () => {},
    });

    // First call with updates mode — should warn.
    const s1 = await graph.stream({ task: "x" }, { streamMode: "updates" });
    for await (const _ of s1) {
      /* consume */
    }
    // Second call — should NOT warn again.
    mockRunAgent.mockResolvedValue(result("y"));
    const s2 = await graph.stream({ task: "y" }, { streamMode: "updates" });
    for await (const _ of s2) {
      /* consume */
    }

    const streamModeWarnings = warn.mock.calls.filter((c) =>
      String(c[0]).includes("streamMode"),
    );
    expect(streamModeWarnings).toHaveLength(1);
    expect(streamModeWarnings[0][0]).toContain('"updates"');
  });

  it("does NOT warn when streamMode is 'values'", async () => {
    mockRunAgent.mockResolvedValueOnce(result("x"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const graph = withDarwinEvolution(buildGraph(), {
      nodeMap: { research: "researcher" },
      onTrajectory: () => {},
    });

    const s = await graph.stream({ task: "x" }, { streamMode: "values" });
    for await (const _ of s) {
      /* consume */
    }

    const streamModeWarnings = warn.mock.calls.filter((c) =>
      String(c[0]).includes("streamMode"),
    );
    expect(streamModeWarnings).toHaveLength(0);
  });

  it("does NOT warn when streamMode array includes 'values'", async () => {
    mockRunAgent.mockResolvedValueOnce(result("x"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const graph = withDarwinEvolution(buildGraph(), {
      nodeMap: { research: "researcher" },
      onTrajectory: () => {},
    });

    const s = await graph.stream(
      { task: "x" },
      { streamMode: ["values", "updates"] as unknown as "values" },
    );
    for await (const _ of s) {
      /* consume */
    }

    const streamModeWarnings = warn.mock.calls.filter((c) =>
      String(c[0]).includes("streamMode"),
    );
    expect(streamModeWarnings).toHaveLength(0);
  });
});

describe("R1 Critic Finding 6 — null trajectory must not crash hook", () => {
  it("hook silently skips when trajectory is null (not undefined)", async () => {
    const baseRes = result("hello");
    // Force trajectory to null instead of undefined to pin the contract.
    const nullTraceRes: RunResult = {
      ...baseRes,
      experiment: {
        ...baseRes.experiment,
        trajectory: null as unknown as ExecutionTrace | undefined,
      },
    };
    mockRunAgent.mockResolvedValueOnce(nullTraceRes);
    const onTrajectory = vi.fn();
    const graph = withDarwinEvolution(buildGraph(), {
      nodeMap: { research: "researcher" },
      onTrajectory,
    });
    await expect(graph.invoke({ task: "x" })).resolves.toBeDefined();
    await new Promise((r) => setImmediate(r));
    expect(onTrajectory).not.toHaveBeenCalled();
  });
});

describe("R1/R2 Research Finding 5 — GraphInterrupt + NodeInterrupt must be re-thrown un-wrapped", () => {
  it("createDarwinNode re-throws a real LangGraph GraphInterrupt", async () => {
    const { GraphInterrupt } = await import("@langchain/langgraph");
    const interrupt = new GraphInterrupt([
      {
        value: "test-pause",
        id: "test-interrupt-1",
      },
    ]);
    mockRunAgent.mockRejectedValueOnce(interrupt);
    const node = createDarwinNode(agent);
    try {
      await node({ task: "x" });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBe(interrupt);
      expect(err).not.toBeInstanceOf(DarwinNodeError);
    }
  });

  it("createDarwinNode re-throws a real LangGraph NodeInterrupt (subclass)", async () => {
    // R2 Research Finding 1 (S1185): the actual error thrown by
    // `interrupt()` inside a node is `NodeInterrupt`, not raw
    // `GraphInterrupt`. The official `isGraphInterrupt` from
    // `@langchain/langgraph` catches both. Our hand-rolled R1 duck-type
    // missed `NodeInterrupt` — this test pins the fix.
    const { NodeInterrupt } = await import("@langchain/langgraph");
    const interrupt = new NodeInterrupt("node-pause");
    mockRunAgent.mockRejectedValueOnce(interrupt);
    const node = createDarwinNode(agent);
    try {
      await node({ task: "x" });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBe(interrupt);
      expect(err).not.toBeInstanceOf(DarwinNodeError);
    }
  });

  it("non-interrupt errors still get wrapped in DarwinNodeError", async () => {
    const upstream = new TypeError("regular failure");
    mockRunAgent.mockRejectedValueOnce(upstream);
    const node = createDarwinNode(agent);
    try {
      await node({ task: "x" });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DarwinNodeError);
      expect((err as DarwinNodeError).cause).toBe(upstream);
    }
  });

  it("treats an error with name='GraphInterrupt' as an interrupt (LangGraph contract)", async () => {
    // LangGraph's official `isGraphInterrupt` checks `err.name` against
    // a stable string constant — meaning any Error whose `.name` is
    // exactly "GraphInterrupt" or "NodeInterrupt" is considered an
    // interrupt and gets re-thrown un-wrapped. This is the documented
    // contract (the `unminifiable_name` static getter exists precisely
    // so the string can be matched across bundlers). The adapter
    // mirrors that contract — passing through whatever LangGraph's
    // `isGraphInterrupt` accepts.
    class NameOnlyInterrupt extends Error {
      public override readonly name = "GraphInterrupt";
    }
    const lookalike = new NameOnlyInterrupt("name-only");
    mockRunAgent.mockRejectedValueOnce(lookalike);
    const node = createDarwinNode(agent);
    try {
      await node({ task: "x" });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBe(lookalike);
      expect(err).not.toBeInstanceOf(DarwinNodeError);
    }
  });

  it("an error with an arbitrary name gets wrapped (not an interrupt)", async () => {
    // Counter-test: an Error whose name is NOT GraphInterrupt/NodeInterrupt
    // is NOT treated as an interrupt and gets wrapped in DarwinNodeError.
    class RandomError extends Error {
      public override readonly name = "SomeRandomError";
    }
    const random = new RandomError("not an interrupt");
    mockRunAgent.mockRejectedValueOnce(random);
    const node = createDarwinNode(agent);
    try {
      await node({ task: "x" });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DarwinNodeError);
      expect((err as DarwinNodeError).cause).toBe(random);
    }
  });
});
