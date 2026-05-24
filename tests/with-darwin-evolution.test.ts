import { StateGraph } from "@langchain/langgraph";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDarwinNode } from "../src/create-darwin-node.js";
import { darwinAnnotation } from "../src/darwin-annotation.js";
import { DarwinEvolutionHookError } from "../src/errors.js";
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

describe("withDarwinEvolution — validation", () => {
  it("throws DarwinEvolutionHookError when nodeMap is missing", () => {
    const g = buildGraph();
    expect(() =>
      withDarwinEvolution(g, {} as Parameters<typeof withDarwinEvolution>[1]),
    ).toThrow(DarwinEvolutionHookError);
  });

  it("throws DarwinEvolutionHookError when nodeMap is empty", () => {
    const g = buildGraph();
    expect(() => withDarwinEvolution(g, { nodeMap: {} })).toThrow(
      DarwinEvolutionHookError,
    );
  });

  it("throws when nodeMap entry has wrong shape", () => {
    const g = buildGraph();
    expect(() =>
      withDarwinEvolution(g, {
        // @ts-expect-error testing runtime guard
        nodeMap: { research: { agentName: 1 } },
      }),
    ).toThrow(DarwinEvolutionHookError);
  });

  it("accepts bare string nodeMap entries", () => {
    const g = buildGraph();
    expect(() =>
      withDarwinEvolution(g, { nodeMap: { research: "researcher" } }),
    ).not.toThrow();
  });

  it("accepts explicit { agentName, trajectoryKey } entries", () => {
    const g = buildGraph();
    expect(() =>
      withDarwinEvolution(g, {
        nodeMap: {
          research: { agentName: "researcher", trajectoryKey: "ttt" },
        },
      }),
    ).not.toThrow();
  });
});

describe("withDarwinEvolution — invoke wrapping", () => {
  it("returns the same graph instance for chaining", () => {
    const g = buildGraph();
    const wrapped = withDarwinEvolution(g, {
      nodeMap: { research: "researcher" },
    });
    expect(wrapped).toBe(g);
  });

  it("forwards graph result unchanged", async () => {
    mockRunAgent.mockResolvedValueOnce(result("hello", 3));
    const g = withDarwinEvolution(buildGraph(), {
      nodeMap: { research: "researcher" },
      onTrajectory: () => {},
    });
    const res = await g.invoke({ task: "x" });
    expect(res).toMatchObject({
      task: "x",
      output: "hello",
      darwinTrajectory: expect.objectContaining({ textBlockCount: 3 }),
    });
  });

  it("fires onTrajectory with correct event payload", async () => {
    mockRunAgent.mockResolvedValueOnce(result("hello", 7));
    const onTrajectory = vi.fn();
    const g = withDarwinEvolution(buildGraph(), {
      nodeMap: { research: "researcher" },
      onTrajectory,
    });
    await g.invoke({ task: "x" });
    // Hook is fire-and-forget — give microtasks a chance to flush.
    await new Promise((r) => setImmediate(r));
    expect(onTrajectory).toHaveBeenCalledOnce();
    const evt = onTrajectory.mock.calls[0][0];
    expect(evt.nodeName).toBe("research");
    expect(evt.agentName).toBe("researcher");
    expect(evt.trajectory.textBlockCount).toBe(7);
    expect(Object.isFrozen(evt.finalState)).toBe(true);
  });

  it("skips hook when trajectory is missing or has wrong version", async () => {
    mockRunAgent.mockResolvedValueOnce({
      ...result("hello"),
      experiment: { ...result("hello").experiment, trajectory: undefined },
    });
    const onTrajectory = vi.fn();
    const g = withDarwinEvolution(buildGraph(), {
      nodeMap: { research: "researcher" },
      onTrajectory,
    });
    await g.invoke({ task: "x" });
    await new Promise((r) => setImmediate(r));
    expect(onTrajectory).not.toHaveBeenCalled();
  });

  it("swallows onTrajectory errors and warns once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockRunAgent.mockResolvedValue(result("hello"));
    const onTrajectory = vi.fn(() => {
      throw new Error("hook boom");
    });
    const g = withDarwinEvolution(buildGraph(), {
      nodeMap: { research: "researcher" },
      onTrajectory,
    });
    await g.invoke({ task: "x" });
    await g.invoke({ task: "y" });
    await g.invoke({ task: "z" });
    await new Promise((r) => setImmediate(r));
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("supports explicit trajectoryKey routing per node", async () => {
    const { Annotation } = await import("@langchain/langgraph");
    const State = darwinAnnotation({
      researchTrace: Annotation<ExecutionTrace | undefined>(),
    });
    const onTrajectory = vi.fn();
    const graph = withDarwinEvolution(
      new StateGraph(State)
        .addNode(
          "research",
          createDarwinNode(agent, { trajectoryKey: "researchTrace" }),
        )
        .addEdge("__start__", "research")
        .compile(),
      {
        nodeMap: {
          research: { agentName: "researcher", trajectoryKey: "researchTrace" },
        },
        onTrajectory,
      },
    );
    mockRunAgent.mockResolvedValueOnce(result("hi", 9));
    await graph.invoke({ task: "x" });
    await new Promise((r) => setImmediate(r));
    expect(onTrajectory).toHaveBeenCalledOnce();
    expect(onTrajectory.mock.calls[0][0].trajectory.textBlockCount).toBe(9);
  });
});

describe("withDarwinEvolution — stream wrapping", () => {
  it("forwards stream chunks unchanged and fires hook after consumer finishes", async () => {
    mockRunAgent.mockResolvedValueOnce(result("streamed", 1));
    const onTrajectory = vi.fn();
    const g = withDarwinEvolution(buildGraph(), {
      nodeMap: { research: "researcher" },
      onTrajectory,
    });
    const stream = await g.stream({ task: "x" }, { streamMode: "values" });
    let lastChunk: unknown = undefined;
    for await (const chunk of stream) {
      lastChunk = chunk;
    }
    expect(lastChunk).toMatchObject({ output: "streamed" });
    await new Promise((r) => setImmediate(r));
    expect(onTrajectory).toHaveBeenCalledOnce();
  });

  it("does not throw if consumer breaks early", async () => {
    mockRunAgent.mockResolvedValueOnce(result("streamed"));
    const onTrajectory = vi.fn();
    const g = withDarwinEvolution(buildGraph(), {
      nodeMap: { research: "researcher" },
      onTrajectory,
    });
    const stream = await g.stream({ task: "x" }, { streamMode: "values" });
    // Break after the first chunk.
    let count = 0;
    for await (const _chunk of stream) {
      count++;
      if (count >= 1) break;
    }
    await new Promise((r) => setImmediate(r));
    // Hook may or may not fire depending on whether last chunk had trajectory.
    // The point is: nothing throws.
    expect(count).toBeGreaterThanOrEqual(1);
  });
});
