import { Annotation, StateGraph } from "@langchain/langgraph";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDarwinNode } from "../src/create-darwin-node.js";
import { darwinAnnotation } from "../src/darwin-annotation.js";
import { DarwinNodeError } from "../src/errors.js";
import type { AgentDefinition, ExecutionTrace, RunResult } from "../src/types.js";

// Mock `runAgent` from darwin-agents. We never invoke a real LLM in tests.
vi.mock("darwin-agents", async (importOriginal) => {
  const original = await importOriginal<typeof import("darwin-agents")>();
  return {
    ...original,
    runAgent: vi.fn(),
  };
});

import { runAgent } from "darwin-agents";

const mockRunAgent = runAgent as unknown as ReturnType<typeof vi.fn>;

const trace = (overrides: Partial<ExecutionTrace> = {}): ExecutionTrace => ({
  version: 1,
  toolCalls: [],
  textBlockCount: 0,
  turnCount: 1,
  mcpInvocations: 0,
  errors: [],
  capturedAt: "2026-05-24T20:00:00.000Z",
  ...overrides,
});

const mockResult = (overrides: Partial<RunResult> = {}): RunResult => ({
  output: "mocked output",
  experiment: {
    id: "exp-mock-2026-05-24-001",
    agentName: "mock",
    promptVersion: "v1.0.0",
    task: "mock task",
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
    trajectory: trace(),
  },
  ...overrides,
});

const agent: AgentDefinition = {
  name: "researcher",
  role: "Topic Researcher",
  description: "Five bullets on a topic.",
  systemPrompt: "Return exactly 5 bullet points.",
};

beforeEach(() => {
  mockRunAgent.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createDarwinNode — input validation", () => {
  it("throws DarwinNodeError when agent lacks a `name`", () => {
    expect(() =>
      // @ts-expect-error testing runtime guard
      createDarwinNode({ role: "x" } as AgentDefinition),
    ).toThrow(DarwinNodeError);
  });

  it("throws DarwinNodeError when agent is null", () => {
    expect(() =>
      createDarwinNode(null as unknown as AgentDefinition),
    ).toThrow(DarwinNodeError);
  });

  it("throws DarwinNodeError at runtime when task is missing", async () => {
    const node = createDarwinNode(agent);
    await expect(node({})).rejects.toThrow(DarwinNodeError);
    await expect(node({})).rejects.toThrow(/non-empty string/);
  });

  it("throws DarwinNodeError when task is not a string", async () => {
    const node = createDarwinNode(agent);
    await expect(node({ task: 42 })).rejects.toThrow(DarwinNodeError);
  });

  it("throws DarwinNodeError when task is an empty string", async () => {
    const node = createDarwinNode(agent);
    await expect(node({ task: "" })).rejects.toThrow(DarwinNodeError);
  });

  it("uses custom taskKey when configured", async () => {
    mockRunAgent.mockResolvedValueOnce(mockResult());
    const node = createDarwinNode(agent, { taskKey: "question" });
    const update = await node({ question: "What is GEPA?" });
    expect(update.output).toBe("mocked output");
    expect(mockRunAgent).toHaveBeenCalledWith(
      agent,
      "What is GEPA?",
      expect.any(Object),
    );
  });
});

describe("createDarwinNode — happy path", () => {
  it("returns the output under default `output` key", async () => {
    mockRunAgent.mockResolvedValueOnce(mockResult({ output: "five bullets" }));
    const node = createDarwinNode(agent);
    const update = await node({ task: "What is GEPA?" });
    expect(update).toEqual({
      output: "five bullets",
      darwinTrajectory: expect.objectContaining({ version: 1 }),
    });
  });

  it("respects custom outputKey + trajectoryKey", async () => {
    mockRunAgent.mockResolvedValueOnce(mockResult({ output: "hello" }));
    const node = createDarwinNode(agent, {
      outputKey: "answer",
      trajectoryKey: "trace",
    });
    const update = await node({ task: "x" });
    expect(update.answer).toBe("hello");
    expect(update.trace).toBeDefined();
    expect(update.output).toBeUndefined();
    expect(update.darwinTrajectory).toBeUndefined();
  });

  it("captureTrace=false suppresses trajectory propagation", async () => {
    mockRunAgent.mockResolvedValueOnce(mockResult());
    const node = createDarwinNode(agent, { captureTrace: false });
    const update = await node({ task: "x" });
    expect(update.darwinTrajectory).toBeUndefined();
    expect(update.output).toBe("mocked output");
  });

  it("omits trajectory key when experiment lacks one (backward-compat)", async () => {
    mockRunAgent.mockResolvedValueOnce(
      mockResult({
        experiment: {
          ...mockResult().experiment,
          trajectory: undefined,
        },
      }),
    );
    const node = createDarwinNode(agent);
    const update = await node({ task: "x" });
    expect(update.darwinTrajectory).toBeUndefined();
    expect(update.output).toBe("mocked output");
  });

  it("forwards runOptions to runAgent", async () => {
    mockRunAgent.mockResolvedValueOnce(mockResult());
    const node = createDarwinNode(agent, {
      runOptions: { model: "claude-haiku-4-5", maxTurns: 3 },
    });
    await node({ task: "x" });
    expect(mockRunAgent).toHaveBeenCalledWith(agent, "x", {
      model: "claude-haiku-4-5",
      maxTurns: 3,
    });
  });
});

describe("createDarwinNode — error wrapping", () => {
  it("wraps runAgent failures in DarwinNodeError", async () => {
    const upstream = new Error("API timeout");
    mockRunAgent.mockRejectedValueOnce(upstream);
    const node = createDarwinNode(agent);
    const promise = node({ task: "x" });
    await expect(promise).rejects.toThrow(DarwinNodeError);
    await expect(promise).rejects.toThrow(/runAgent failed: API timeout/);
  });

  it("preserves the original error via `cause`", async () => {
    const upstream = new Error("API timeout");
    mockRunAgent.mockRejectedValueOnce(upstream);
    const node = createDarwinNode(agent);
    try {
      await node({ task: "x" });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DarwinNodeError);
      expect((err as DarwinNodeError).cause).toBe(upstream);
      expect((err as DarwinNodeError).agentName).toBe("researcher");
    }
  });
});

describe("createDarwinNode — onResult callback", () => {
  it("calls onResult after successful run", async () => {
    const result = mockResult();
    mockRunAgent.mockResolvedValueOnce(result);
    const onResult = vi.fn();
    const node = createDarwinNode(agent, { onResult });
    await node({ task: "x" });
    expect(onResult).toHaveBeenCalledWith(result);
  });

  it("swallows synchronous onResult errors and warns once", async () => {
    mockRunAgent.mockResolvedValue(mockResult());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onResult = vi.fn(() => {
      throw new Error("boom");
    });
    const node = createDarwinNode(agent, { onResult });
    await expect(node({ task: "x" })).resolves.toBeDefined();
    await expect(node({ task: "x" })).resolves.toBeDefined();
    await expect(node({ task: "x" })).resolves.toBeDefined();
    expect(onResult).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("swallows async onResult rejections", async () => {
    mockRunAgent.mockResolvedValueOnce(mockResult());
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const onResult = vi.fn(async () => {
      throw new Error("async boom");
    });
    const node = createDarwinNode(agent, { onResult });
    await expect(node({ task: "x" })).resolves.toBeDefined();
    expect(onResult).toHaveBeenCalledOnce();
  });
});

describe("createDarwinNode — StateGraph integration", () => {
  it("plugs into a real LangGraph and produces the expected state", async () => {
    mockRunAgent.mockResolvedValueOnce(
      mockResult({ output: "5 bullets here" }),
    );
    const State = darwinAnnotation();
    const graph = new StateGraph(State)
      .addNode("research", createDarwinNode(agent))
      .addEdge("__start__", "research")
      .compile();
    const result = await graph.invoke({ task: "What is GEPA?" });
    expect(result.output).toBe("5 bullets here");
    expect(result.task).toBe("What is GEPA?");
    expect(result.darwinTrajectory?.version).toBe(1);
  });

  it("multi-node graph: each node receives the same task, writes its own output", async () => {
    mockRunAgent
      .mockResolvedValueOnce(mockResult({ output: "first" }))
      .mockResolvedValueOnce(mockResult({ output: "second" }));
    const State = darwinAnnotation({
      first: Annotation<string>(),
      second: Annotation<string>(),
    });
    const graph = new StateGraph(State)
      .addNode("a", createDarwinNode(agent, { outputKey: "first" }))
      .addNode("b", createDarwinNode(agent, { outputKey: "second" }))
      .addEdge("__start__", "a")
      .addEdge("a", "b")
      .compile();
    const result = await graph.invoke({ task: "x" });
    expect(result.first).toBe("first");
    expect(result.second).toBe("second");
    expect(mockRunAgent).toHaveBeenCalledTimes(2);
  });
});
