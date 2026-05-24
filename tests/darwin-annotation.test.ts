import { Annotation, StateGraph } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";

import {
  darwinAnnotation,
  getDarwinChannelSpec,
  lastWriteWinsTrajectoryReducer,
} from "../src/darwin-annotation.js";
import type { ExecutionTrace } from "../src/types.js";

const fakeTrace = (capturedAt = "2026-05-24T20:00:00.000Z"): ExecutionTrace => ({
  version: 1,
  toolCalls: [],
  textBlockCount: 0,
  turnCount: 1,
  mcpInvocations: 0,
  errors: [],
  capturedAt,
});

describe("lastWriteWinsTrajectoryReducer", () => {
  it("returns the new value, ignoring the previous", () => {
    const a = fakeTrace("2026-05-24T20:00:00.000Z");
    const b = fakeTrace("2026-05-24T20:01:00.000Z");
    expect(lastWriteWinsTrajectoryReducer(a, b)).toBe(b);
  });

  it("returns undefined when the new value is undefined", () => {
    const a = fakeTrace();
    expect(lastWriteWinsTrajectoryReducer(a, undefined)).toBeUndefined();
  });

  it("handles undefined previous", () => {
    const b = fakeTrace();
    expect(lastWriteWinsTrajectoryReducer(undefined, b)).toBe(b);
  });
});

describe("getDarwinChannelSpec", () => {
  it("returns three channels: task, output, darwinTrajectory", () => {
    const spec = getDarwinChannelSpec();
    expect(Object.keys(spec).sort()).toEqual([
      "darwinTrajectory",
      "output",
      "task",
    ]);
  });

  it("returns a fresh object on every call", () => {
    const a = getDarwinChannelSpec();
    const b = getDarwinChannelSpec();
    expect(a).not.toBe(b);
  });
});

describe("darwinAnnotation", () => {
  it("builds an Annotation.Root that StateGraph accepts", () => {
    const State = darwinAnnotation();
    // StateGraph constructor will throw if the schema is malformed.
    const graph = new StateGraph(State)
      .addNode("noop", async (_state) => ({}))
      .addEdge("__start__", "noop")
      .compile();
    expect(graph).toBeDefined();
  });

  it("invokes through the default channels (task → output)", async () => {
    const State = darwinAnnotation();
    const graph = new StateGraph(State)
      .addNode("noop", async (state) => ({
        output: `echo: ${state.task}`,
      }))
      .addEdge("__start__", "noop")
      .compile();
    const result = await graph.invoke({ task: "hi" });
    expect(result.output).toBe("echo: hi");
  });

  it("composes with extra channels", async () => {
    const State = darwinAnnotation({
      counter: Annotation<number>({
        reducer: (a: number, b: number) => a + b,
        default: () => 0,
      }),
    });
    const graph = new StateGraph(State)
      .addNode("increment", async () => ({ counter: 5 }))
      .addEdge("__start__", "increment")
      .compile();
    const result = await graph.invoke({ task: "x", counter: 1 });
    expect(result.counter).toBe(6);
    expect(result.task).toBe("x");
  });

  it("trajectory channel uses last-write-wins reducer", async () => {
    const State = darwinAnnotation();
    const traceA = fakeTrace("2026-05-24T20:00:00.000Z");
    const traceB = fakeTrace("2026-05-24T20:01:00.000Z");
    const graph = new StateGraph(State)
      .addNode("first", async () => ({ darwinTrajectory: traceA }))
      .addNode("second", async () => ({ darwinTrajectory: traceB }))
      .addEdge("__start__", "first")
      .addEdge("first", "second")
      .compile();
    const result = await graph.invoke({ task: "x" });
    expect(result.darwinTrajectory).toBe(traceB);
  });

  it("trajectory default is undefined when no node writes it", async () => {
    const State = darwinAnnotation();
    const graph = new StateGraph(State)
      .addNode("noop", async () => ({ output: "" }))
      .addEdge("__start__", "noop")
      .compile();
    const result = await graph.invoke({ task: "x" });
    expect(result.darwinTrajectory).toBeUndefined();
  });
});
