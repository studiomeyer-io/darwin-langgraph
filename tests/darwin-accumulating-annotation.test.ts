/**
 * V0.4 regression tests — `darwinAccumulatingAnnotation` +
 * `darwinTrajectoryAccumulatorReducer`.
 *
 * Coverage: reducer concat single + array, undefined/null no-op, drop
 * non-trace shapes defensively, annotation factory composes extra channels.
 */

import { Annotation, StateGraph } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";

import {
  darwinAccumulatingAnnotation,
  darwinTrajectoryAccumulatorReducer,
  getDarwinAccumulatingChannelSpec,
} from "../src/darwin-accumulating-annotation.js";
import type { ExecutionTrace } from "../src/types.js";

const trace = (n: number): ExecutionTrace => ({
  version: 1,
  toolCalls: [],
  textBlockCount: n,
  turnCount: 1,
  mcpInvocations: 0,
  errors: [],
  capturedAt: "2026-05-29T00:00:00.000Z",
});

describe("darwinTrajectoryAccumulatorReducer — single trace", () => {
  it("appends a single ExecutionTrace to the accumulator", () => {
    const result = darwinTrajectoryAccumulatorReducer([], trace(1));
    expect(result).toHaveLength(1);
    expect(result[0]?.textBlockCount).toBe(1);
  });

  it("appends to an existing array", () => {
    const result = darwinTrajectoryAccumulatorReducer(
      [trace(1), trace(2)],
      trace(3),
    );
    expect(result).toHaveLength(3);
    expect(result.map((t) => t.textBlockCount)).toEqual([1, 2, 3]);
  });

  it("treats undefined prev as empty array", () => {
    const result = darwinTrajectoryAccumulatorReducer(undefined, trace(7));
    expect(result).toEqual([trace(7)]);
  });
});

describe("darwinTrajectoryAccumulatorReducer — array next", () => {
  it("flattens an array of ExecutionTraces", () => {
    const result = darwinTrajectoryAccumulatorReducer(
      [trace(1)],
      [trace(2), trace(3)],
    );
    expect(result).toHaveLength(3);
    expect(result.map((t) => t.textBlockCount)).toEqual([1, 2, 3]);
  });

  it("filters non-trace items inside arrays", () => {
    const result = darwinTrajectoryAccumulatorReducer(
      [trace(1)],
      // @ts-expect-error — intentional mixed input
      [trace(2), { not_a_trace: true }, null, trace(3)],
    );
    expect(result).toHaveLength(3);
    expect(result.map((t) => t.textBlockCount)).toEqual([1, 2, 3]);
  });

  it("drops an array with zero valid items (returns prev untouched)", () => {
    const prev = [trace(5)];
    const result = darwinTrajectoryAccumulatorReducer(
      prev,
      // @ts-expect-error — intentional invalid
      [{}, null, undefined],
    );
    expect(result).toEqual(prev);
  });
});

describe("darwinTrajectoryAccumulatorReducer — no-op cases", () => {
  it("undefined next returns prev unchanged", () => {
    const prev = [trace(1), trace(2)];
    const result = darwinTrajectoryAccumulatorReducer(prev, undefined);
    expect(result).toEqual(prev);
  });

  it("null next returns prev unchanged", () => {
    const prev = [trace(1)];
    const result = darwinTrajectoryAccumulatorReducer(
      prev,
      // @ts-expect-error — intentional null
      null,
    );
    expect(result).toEqual(prev);
  });

  it("non-trace next returns prev unchanged", () => {
    const prev = [trace(1)];
    const result = darwinTrajectoryAccumulatorReducer(
      prev,
      // @ts-expect-error — intentional invalid shape
      { foo: "bar" },
    );
    expect(result).toEqual(prev);
  });

  it("forward-compat — v>=2 trajectory is ACCEPTED (R1 P0-2 fix)", () => {
    // R1 P0-2 fix (S1235): the accumulator reducer accepts version >= 1,
    // matching `isExecutionTrace` so v=2 trajectories flow through both
    // the DarwinCallbackHandler.onTrajectory hook AND the accumulator
    // channel consistently.
    const future = { ...trace(1), version: 99 } as ExecutionTrace;
    const result = darwinTrajectoryAccumulatorReducer([], future);
    expect(result).toEqual([future]);
  });

  it("rejects non-number version (still invalid)", () => {
    const bad = { ...trace(1), version: "1" as unknown as number } as ExecutionTrace;
    const result = darwinTrajectoryAccumulatorReducer([], bad);
    expect(result).toEqual([]);
  });

  it("rejects version < 1 (older than baseline)", () => {
    const old = { ...trace(1), version: 0 } as ExecutionTrace;
    const result = darwinTrajectoryAccumulatorReducer([], old);
    expect(result).toEqual([]);
  });
});

describe("getDarwinAccumulatingChannelSpec — shape", () => {
  it("exposes task + output + darwinTrajectories channels", () => {
    const spec = getDarwinAccumulatingChannelSpec();
    expect(Object.keys(spec).sort()).toEqual([
      "darwinTrajectories",
      "output",
      "task",
    ]);
  });

  it("drops the singleton darwinTrajectory channel (replaced by plural)", () => {
    const spec = getDarwinAccumulatingChannelSpec();
    expect("darwinTrajectory" in spec).toBe(false);
  });
});

describe("darwinAccumulatingAnnotation — usage with StateGraph", () => {
  it("default annotation can be passed to StateGraph constructor", () => {
    const State = darwinAccumulatingAnnotation();
    // Should not throw — LangGraph happily accepts our Annotation.Root.
    expect(() => new StateGraph(State)).not.toThrow();
  });

  it("extra channels merge in alongside accumulator", () => {
    const State = darwinAccumulatingAnnotation({
      reviewNotes: Annotation<string[]>({
        reducer: (a, b) => a.concat(b),
        default: () => [],
      }),
    });
    expect(() => new StateGraph(State)).not.toThrow();
  });

  it("compiled graph with one node accumulates a single trajectory", async () => {
    const State = darwinAccumulatingAnnotation();
    const graph = new StateGraph(State)
      .addNode("research", () => ({
        darwinTrajectories: trace(42),
      }))
      .addEdge("__start__", "research")
      .compile();
    const result = await graph.invoke({ task: "x" });
    expect(result.darwinTrajectories).toHaveLength(1);
    expect(result.darwinTrajectories[0]?.textBlockCount).toBe(42);
  });

  it("compiled graph with two sequential nodes accumulates BOTH trajectories", async () => {
    const State = darwinAccumulatingAnnotation();
    const graph = new StateGraph(State)
      .addNode("first", () => ({ darwinTrajectories: trace(1) }))
      .addNode("second", () => ({ darwinTrajectories: trace(2) }))
      .addEdge("__start__", "first")
      .addEdge("first", "second")
      .compile();
    const result = await graph.invoke({ task: "x" });
    expect(result.darwinTrajectories).toHaveLength(2);
    expect(result.darwinTrajectories.map((t) => t.textBlockCount).sort()).toEqual(
      [1, 2],
    );
  });
});
