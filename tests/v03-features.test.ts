/**
 * V0.3 regression tests (S1187, 2026-05-25).
 *
 * Covers the four V0.3 surface additions:
 *   1. parent-run propagation on `DarwinTrajectoryEvent` via
 *      `DarwinCallbackHandler` (`runId` + `parentRunId` fields).
 *   2. Double-wrap warning on `withDarwinEvolution` (Symbol sentinel
 *      stamped on wrapped graphs).
 *   3. Hung-invoke timeout guard on `DarwinCallbackHandler`
 *      (`maxInFlightRuns` option with LRU eviction + one-shot warn).
 *   4. `vi.resetModules()` pattern for module-level deprecation /
 *      double-wrap flags — exercises that the warnings DO emit again
 *      after a module-fresh import.
 */

import { StateGraph } from "@langchain/langgraph";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDarwinNode } from "../src/create-darwin-node.js";
import { DarwinCallbackHandler } from "../src/darwin-callback-handler.js";
import { darwinAnnotation } from "../src/darwin-annotation.js";
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

// ---------------------------------------------------------------------------
// V0.3 #1 — parent-run propagation
// ---------------------------------------------------------------------------

describe("V0.3: DarwinCallbackHandler — parent-run propagation", () => {
  it("populates `runId` on DarwinTrajectoryEvent after a real invoke", async () => {
    mockRunAgent.mockResolvedValueOnce(result("hello", 4));
    const onTrajectory = vi.fn();
    const handler = new DarwinCallbackHandler({
      nodeMap: { research: "researcher" },
      onTrajectory,
    });
    const g = buildGraph();
    await g.invoke({ task: "x" }, { callbacks: [handler] });
    await new Promise((resolve) => setImmediate(resolve));
    expect(onTrajectory).toHaveBeenCalledOnce();
    const evt = onTrajectory.mock.calls[0][0];
    expect(typeof evt.runId).toBe("string");
    expect(evt.runId.length).toBeGreaterThan(8);
  });

  it("populates `parentRunId` on DarwinTrajectoryEvent for nested chain events", () => {
    // Synthetic: handleChainStart with a parentRunId arg, then matching
    // handleChainEnd. The handler should propagate both onto the event.
    const onTrajectory = vi.fn();
    const handler = new DarwinCallbackHandler({
      nodeMap: { research: "researcher" },
      onTrajectory,
    });
    handler.handleChainStart(
      {} as never,
      {} as never,
      "run-child",
      undefined,
      undefined,
      { langgraph_node: "research" },
      "research",
      "run-parent",
    );
    handler.handleChainEnd(
      {
        task: "x",
        output: "ok",
        darwinTrajectory: trace(2),
      } as never,
      "run-child",
    );
    return new Promise((resolve) => setImmediate(resolve)).then(() => {
      expect(onTrajectory).toHaveBeenCalledOnce();
      const evt = onTrajectory.mock.calls[0][0];
      expect(evt.runId).toBe("run-child");
      expect(evt.parentRunId).toBe("run-parent");
    });
  });

  it("omits `parentRunId` when the chain has no parent (top-level invoke)", () => {
    const onTrajectory = vi.fn();
    const handler = new DarwinCallbackHandler({
      nodeMap: { research: "researcher" },
      onTrajectory,
    });
    handler.handleChainStart(
      {} as never,
      {} as never,
      "run-top",
      undefined,
      undefined,
      { langgraph_node: "research" },
      "research",
      undefined, // no parent
    );
    handler.handleChainEnd(
      {
        task: "x",
        output: "ok",
        darwinTrajectory: trace(1),
      } as never,
      "run-top",
    );
    return new Promise((resolve) => setImmediate(resolve)).then(() => {
      expect(onTrajectory).toHaveBeenCalledOnce();
      const evt = onTrajectory.mock.calls[0][0];
      expect(evt.runId).toBe("run-top");
      expect("parentRunId" in evt).toBe(false);
    });
  });

  it("preserves runId across concurrent invokes (no cross-contamination)", async () => {
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
    const ids = onTrajectory.mock.calls.map((c) => c[0].runId);
    expect(new Set(ids).size).toBe(2); // two distinct runIds
  });
});

// ---------------------------------------------------------------------------
// V0.3 #2 — double-wrap warning
// ---------------------------------------------------------------------------

describe("V0.3: withDarwinEvolution — double-wrap warning", () => {
  it("warns once when the same graph is wrapped twice", async () => {
    // Use isolated module instance so the module-level flag starts false.
    vi.resetModules();
    const { withDarwinEvolution } = await import(
      "../src/with-darwin-evolution.js"
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const g = buildGraph();
    withDarwinEvolution(g, { nodeMap: { research: "researcher" } });
    withDarwinEvolution(g, { nodeMap: { research: "researcher" } });
    // First wrap: deprecation warning.
    // Second wrap: deprecation (already silenced) + double-wrap warning.
    const calls = warn.mock.calls.map((c) => String(c[0]));
    expect(calls.some((c) => c.includes("wrapped twice"))).toBe(true);
  });

  it("does NOT warn double-wrap when wrapping two DIFFERENT graphs", async () => {
    vi.resetModules();
    const { withDarwinEvolution } = await import(
      "../src/with-darwin-evolution.js"
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const g1 = buildGraph();
    const g2 = buildGraph();
    withDarwinEvolution(g1, { nodeMap: { research: "researcher" } });
    withDarwinEvolution(g2, { nodeMap: { research: "researcher" } });
    const calls = warn.mock.calls.map((c) => String(c[0]));
    expect(calls.some((c) => c.includes("wrapped twice"))).toBe(false);
  });

  it("stamps a non-enumerable Symbol sentinel on the wrapped graph", async () => {
    vi.resetModules();
    const { withDarwinEvolution } = await import(
      "../src/with-darwin-evolution.js"
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const g = buildGraph();
    withDarwinEvolution(g, { nodeMap: { research: "researcher" } });
    const sentinel = Symbol.for("darwin-langgraph.evolution.wrapped");
    expect((g as Record<symbol, unknown>)[sentinel]).toBe(true);
    // Non-enumerable so JSON.stringify doesn't leak it.
    expect(JSON.stringify(g)).not.toContain("evolution.wrapped");
  });

  it("does not throw on the second wrap — both hooks fire (legitimate layering)", async () => {
    vi.resetModules();
    const { withDarwinEvolution } = await import(
      "../src/with-darwin-evolution.js"
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockRunAgent.mockResolvedValueOnce(result("hello", 1));
    const h1 = vi.fn();
    const h2 = vi.fn();
    const g = buildGraph();
    withDarwinEvolution(g, {
      nodeMap: { research: "researcher" },
      onTrajectory: h1,
    });
    withDarwinEvolution(g, {
      nodeMap: { research: "researcher" },
      onTrajectory: h2,
    });
    await g.invoke({ task: "x" });
    await new Promise((resolve) => setImmediate(resolve));
    // Both hooks fired (this is the footgun the warning is for).
    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// V0.3 #3 — hung-invoke timeout guard (maxInFlightRuns)
// ---------------------------------------------------------------------------

describe("V0.3: DarwinCallbackHandler — hung-invoke timeout guard", () => {
  it("evicts the oldest in-flight entry when maxInFlightRuns is exceeded", () => {
    const onTrajectory = vi.fn();
    const handler = new DarwinCallbackHandler({
      nodeMap: { research: "researcher" },
      onTrajectory,
      maxInFlightRuns: 3,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Push 4 starts without ends — the 4th must evict the 1st.
    for (let i = 1; i <= 4; i++) {
      handler.handleChainStart(
        {} as never,
        {} as never,
        `run-${i}`,
        undefined,
        undefined,
        { langgraph_node: "research" },
        "research",
      );
    }
    // Map size stays at the cap.
    expect(handler.getInFlightCount()).toBe(3);
    // run-1 was evicted. Sending its end fires nothing.
    handler.handleChainEnd(
      { task: "x", output: "ok", darwinTrajectory: trace(1) } as never,
      "run-1",
    );
    expect(onTrajectory).not.toHaveBeenCalled();
    // run-2 still tracked.
    handler.handleChainEnd(
      { task: "x", output: "ok", darwinTrajectory: trace(2) } as never,
      "run-2",
    );
    return new Promise((resolve) => setImmediate(resolve)).then(() => {
      expect(onTrajectory).toHaveBeenCalledOnce();
      // Eviction warning fired exactly once.
      const evictionWarns = warn.mock.calls.filter((c) =>
        String(c[0]).includes("in-flight runs exceeded"),
      );
      expect(evictionWarns).toHaveLength(1);
    });
  });

  it("warns once across many evictions (no log spam)", () => {
    const handler = new DarwinCallbackHandler({
      nodeMap: { research: "researcher" },
      onTrajectory: () => {},
      maxInFlightRuns: 2,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 1; i <= 10; i++) {
      handler.handleChainStart(
        {} as never,
        {} as never,
        `run-${i}`,
        undefined,
        undefined,
        { langgraph_node: "research" },
        "research",
      );
    }
    const evictionWarns = warn.mock.calls.filter((c) =>
      String(c[0]).includes("in-flight runs exceeded"),
    );
    expect(evictionWarns).toHaveLength(1);
  });

  it("defaults to 1024 when option is omitted", () => {
    const handler = new DarwinCallbackHandler({
      nodeMap: { research: "researcher" },
      onTrajectory: () => {},
    });
    // White-box: push 1025 starts and verify cap held at 1024.
    for (let i = 1; i <= 1025; i++) {
      handler.handleChainStart(
        {} as never,
        {} as never,
        `run-${i}`,
        undefined,
        undefined,
        { langgraph_node: "research" },
        "research",
      );
    }
    expect(handler.getInFlightCount()).toBe(1024);
  });

  it("opts out of the cap when Infinity is passed", () => {
    const handler = new DarwinCallbackHandler({
      nodeMap: { research: "researcher" },
      onTrajectory: () => {},
      maxInFlightRuns: Infinity,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 1; i <= 2050; i++) {
      handler.handleChainStart(
        {} as never,
        {} as never,
        `run-${i}`,
        undefined,
        undefined,
        { langgraph_node: "research" },
        "research",
      );
    }
    expect(handler.getInFlightCount()).toBe(2050);
    const evictionWarns = warn.mock.calls.filter((c) =>
      String(c[0]).includes("in-flight runs exceeded"),
    );
    expect(evictionWarns).toHaveLength(0);
  });

  it("falls back to default on invalid input (NaN / negative / 0 / non-number)", () => {
    const cases = [NaN, -5, 0, "not a number" as unknown as number];
    for (const c of cases) {
      const handler = new DarwinCallbackHandler({
        nodeMap: { research: "researcher" },
        onTrajectory: () => {},
        maxInFlightRuns: c,
      });
      for (let i = 1; i <= 1025; i++) {
        handler.handleChainStart(
          {} as never,
          {} as never,
          `run-${i}`,
          undefined,
          undefined,
          { langgraph_node: "research" },
          "research",
        );
      }
      expect(handler.getInFlightCount()).toBe(1024);
    }
  });

  it("re-firing the same runId does NOT evict another entry (replace-in-place)", () => {
    const handler = new DarwinCallbackHandler({
      nodeMap: { research: "researcher" },
      onTrajectory: () => {},
      maxInFlightRuns: 3,
    });
    // Fill to cap.
    for (let i = 1; i <= 3; i++) {
      handler.handleChainStart(
        {} as never,
        {} as never,
        `run-${i}`,
        undefined,
        undefined,
        { langgraph_node: "research" },
        "research",
      );
    }
    expect(handler.getInFlightCount()).toBe(3);
    // Re-fire run-2 — should NOT evict run-1.
    handler.handleChainStart(
      {} as never,
      {} as never,
      "run-2",
      undefined,
      undefined,
      { langgraph_node: "research" },
      "research",
    );
    expect(handler.getInFlightCount()).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// V0.3 #4 — vi.resetModules() pattern for module-level flag tests
// ---------------------------------------------------------------------------

describe("V0.3: vi.resetModules() pattern for module-level deprecation flag", () => {
  it("deprecation warning fires again after vi.resetModules() re-import", async () => {
    // First import — warning fires once on first call.
    vi.resetModules();
    const mod1 = await import("../src/with-darwin-evolution.js");
    const warn1 = vi.spyOn(console, "warn").mockImplementation(() => {});
    mod1.withDarwinEvolution(buildGraph(), {
      nodeMap: { research: "researcher" },
    });
    mod1.withDarwinEvolution(buildGraph(), {
      nodeMap: { research: "researcher" },
    });
    const depWarns1 = warn1.mock.calls.filter((c) =>
      String(c[0]).includes("deprecated since v0.2.0"),
    );
    expect(depWarns1).toHaveLength(1);
    warn1.mockRestore();

    // Re-import via resetModules — module-level flag is fresh.
    vi.resetModules();
    const mod2 = await import("../src/with-darwin-evolution.js");
    const warn2 = vi.spyOn(console, "warn").mockImplementation(() => {});
    mod2.withDarwinEvolution(buildGraph(), {
      nodeMap: { research: "researcher" },
    });
    const depWarns2 = warn2.mock.calls.filter((c) =>
      String(c[0]).includes("deprecated since v0.2.0"),
    );
    expect(depWarns2).toHaveLength(1); // fires again — clean module state
  });

  it("double-wrap flag is also reset by vi.resetModules()", async () => {
    vi.resetModules();
    const { withDarwinEvolution } = await import(
      "../src/with-darwin-evolution.js"
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const g = buildGraph();
    withDarwinEvolution(g, { nodeMap: { research: "researcher" } });
    withDarwinEvolution(g, { nodeMap: { research: "researcher" } });
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes("wrapped twice")),
    ).toBe(true);
  });
});
