/**
 * Tests for the `runOptions.provider` passthrough on {@link createDarwinNode}
 * (V0.5.2).
 *
 * `darwin-agents` `RunOptions` has carried `provider?: LLMProvider` since
 * `0.5.0-alpha.1`, but the adapter's `DarwinRunOptionsPassthrough` forgot to
 * mirror it — so consumers could not inject a pre-constructed provider through
 * the node. These tests pin the forwarding behaviour (unit + StateGraph
 * integration) so it cannot silently regress.
 */
import { StateGraph } from "@langchain/langgraph";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDarwinNode } from "../src/create-darwin-node.js";
import { darwinAnnotation } from "../src/darwin-annotation.js";
import type {
  AgentDefinition,
  ExecutionTrace,
  LLMProvider,
  RunResult,
} from "../src/types.js";

// Mock `runAgent` — we never invoke a real LLM in tests.
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
  capturedAt: "2026-06-21T20:00:00.000Z",
  ...overrides,
});

const mockResult = (overrides: Partial<RunResult> = {}): RunResult => ({
  output: "mocked output",
  experiment: {
    id: "exp-mock-2026-06-21-001",
    agentName: "mock",
    promptVersion: "v1.0.0",
    task: "mock task",
    taskType: "test",
    startedAt: "2026-06-21T20:00:00.000Z",
    completedAt: "2026-06-21T20:00:01.000Z",
    success: true,
    metrics: {
      qualityScore: 10,
      sourceCount: 3,
      outputLength: 120,
      errorCount: 0,
      durationMs: 1000,
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

// Minimal LLMProvider double — the adapter forwards it verbatim, never calls
// it (runAgent is mocked), so a structural stub is enough.
const fakeProvider: LLMProvider = {
  name: "fake-test-provider",
  supportsMcp: false,
  run: vi.fn(),
};

beforeEach(() => {
  mockRunAgent.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createDarwinNode — runOptions.provider passthrough", () => {
  it("forwards a provider instance verbatim to runAgent", async () => {
    mockRunAgent.mockResolvedValueOnce(mockResult());
    const node = createDarwinNode(agent, {
      runOptions: { provider: fakeProvider },
    });
    await node({ task: "x" });
    expect(mockRunAgent).toHaveBeenCalledWith(agent, "x", {
      provider: fakeProvider,
    });
    // Same reference — not a copy.
    const forwarded = mockRunAgent.mock.calls[0][2] as {
      provider?: LLMProvider;
    };
    expect(forwarded.provider).toBe(fakeProvider);
  });

  it("forwards provider alongside other runOptions", async () => {
    mockRunAgent.mockResolvedValueOnce(mockResult());
    const node = createDarwinNode(agent, {
      runOptions: {
        provider: fakeProvider,
        model: "claude-haiku-4-5",
        maxTurns: 2,
      },
    });
    await node({ task: "x" });
    expect(mockRunAgent).toHaveBeenCalledWith(agent, "x", {
      provider: fakeProvider,
      model: "claude-haiku-4-5",
      maxTurns: 2,
    });
  });

  it("does not invent a provider when none is supplied", async () => {
    mockRunAgent.mockResolvedValueOnce(mockResult());
    const node = createDarwinNode(agent, { runOptions: { model: "x" } });
    await node({ task: "x" });
    const forwarded = mockRunAgent.mock.calls[0][2] as {
      provider?: LLMProvider;
    };
    expect(forwarded.provider).toBeUndefined();
    expect("provider" in forwarded).toBe(false);
  });

  it("threads the provider through a real StateGraph node", async () => {
    mockRunAgent.mockResolvedValueOnce(mockResult({ output: "5 bullets" }));
    const State = darwinAnnotation();
    const graph = new StateGraph(State)
      .addNode(
        "research",
        createDarwinNode(agent, { runOptions: { provider: fakeProvider } }),
      )
      .addEdge("__start__", "research")
      .compile();
    const result = await graph.invoke({ task: "What is GEPA?" });
    expect(result.output).toBe("5 bullets");
    const forwarded = mockRunAgent.mock.calls[0][2] as {
      provider?: LLMProvider;
    };
    expect(forwarded.provider).toBe(fakeProvider);
  });
});
