/**
 * Integration tests — exercise the three surfaces together in patterns
 * a real consumer would write. All LLM calls are mocked via the
 * `darwin-agents.runAgent` stub.
 */

import { Annotation, StateGraph } from "@langchain/langgraph";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createDarwinNode,
  darwinAnnotation,
  withDarwinEvolution,
  VERSION,
} from "../src/index.js";
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

const trace = (mcp = 0): ExecutionTrace => ({
  version: 1,
  toolCalls: [],
  textBlockCount: 1,
  turnCount: 1,
  mcpInvocations: mcp,
  errors: [],
  capturedAt: "2026-05-24T20:00:00.000Z",
});

const result = (output: string, mcp = 0): RunResult => ({
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
    trajectory: trace(mcp),
  },
});

const mkAgent = (name: string): AgentDefinition => ({
  name,
  role: `${name}-role`,
  description: `${name}-desc`,
  systemPrompt: `${name}-prompt`,
});

beforeEach(() => mockRunAgent.mockReset());
afterEach(() => vi.restoreAllMocks());

describe("VERSION", () => {
  it("matches the major.minor.patch tag we publish under", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+(-[a-z]+\.\d+)?$/);
  });
});

describe("multi-agent research pipeline", () => {
  it("researcher → critic chain with separate trajectory keys", async () => {
    mockRunAgent
      .mockResolvedValueOnce(result("5 bullets", 2))
      .mockResolvedValueOnce(result("critic: looks good", 0));

    const State = darwinAnnotation({
      research: Annotation<string>(),
      critique: Annotation<string>(),
      researchTrace: Annotation<ExecutionTrace | undefined>(),
      critiqueTrace: Annotation<ExecutionTrace | undefined>(),
    });

    const trajectories: Array<{ node: string; mcp: number }> = [];

    const graph = withDarwinEvolution(
      new StateGraph(State)
        .addNode(
          "researcher",
          createDarwinNode(mkAgent("researcher"), {
            outputKey: "research",
            trajectoryKey: "researchTrace",
          }),
        )
        .addNode(
          "critic",
          createDarwinNode(mkAgent("critic"), {
            taskKey: "research",
            outputKey: "critique",
            trajectoryKey: "critiqueTrace",
          }),
        )
        .addEdge("__start__", "researcher")
        .addEdge("researcher", "critic")
        .compile(),
      {
        nodeMap: {
          researcher: { agentName: "researcher", trajectoryKey: "researchTrace" },
          critic: { agentName: "critic", trajectoryKey: "critiqueTrace" },
        },
        onTrajectory: (event) => {
          trajectories.push({
            node: event.nodeName,
            mcp: event.trajectory.mcpInvocations,
          });
        },
      },
    );

    const res = await graph.invoke({ task: "What is GEPA?" });
    await new Promise((r) => setImmediate(r));

    expect(res.research).toBe("5 bullets");
    expect(res.critique).toBe("critic: looks good");
    expect(trajectories).toHaveLength(2);
    expect(trajectories.sort((a, b) => a.node.localeCompare(b.node))).toEqual([
      { node: "critic", mcp: 0 },
      { node: "researcher", mcp: 2 },
    ]);
  });
});

describe("evolution hook + onResult both fire", () => {
  it("graph hook + per-node onResult coexist", async () => {
    mockRunAgent.mockResolvedValueOnce(result("hello"));

    const perNodeOnResult = vi.fn();
    const onTrajectory = vi.fn();

    const State = darwinAnnotation();
    const graph = withDarwinEvolution(
      new StateGraph(State)
        .addNode(
          "research",
          createDarwinNode(mkAgent("researcher"), { onResult: perNodeOnResult }),
        )
        .addEdge("__start__", "research")
        .compile(),
      { nodeMap: { research: "researcher" }, onTrajectory },
    );

    await graph.invoke({ task: "x" });
    await new Promise((r) => setImmediate(r));

    expect(perNodeOnResult).toHaveBeenCalledOnce();
    expect(onTrajectory).toHaveBeenCalledOnce();
  });
});
