/**
 * Tests for `darwinMessagesAnnotation` (V0.2, MessagesAnnotation interop).
 */

import {
  HumanMessage,
  AIMessage,
} from "@langchain/core/messages";
import { StateGraph } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";

import {
  darwinMessagesAnnotation,
  getMessagesChannelSpec,
} from "../src/darwin-messages-annotation.js";

describe("getMessagesChannelSpec", () => {
  it("returns a spec with `messages` key", () => {
    const spec = getMessagesChannelSpec();
    expect(Object.keys(spec)).toEqual(["messages"]);
  });

  it("returns a fresh object on every call", () => {
    const a = getMessagesChannelSpec();
    const b = getMessagesChannelSpec();
    expect(a).not.toBe(b);
  });
});

describe("darwinMessagesAnnotation — base channels + messages", () => {
  it("returns a StateGraph-compatible annotation", () => {
    const State = darwinMessagesAnnotation();
    const graph = new StateGraph(State)
      .addNode("noop", async () => ({}))
      .addEdge("__start__", "noop")
      .compile();
    expect(graph).toBeDefined();
  });

  it("messages channel accumulates via messagesStateReducer", async () => {
    const State = darwinMessagesAnnotation();
    const graph = new StateGraph(State)
      .addNode("emit_a", async () => ({
        messages: [new HumanMessage("hello")],
      }))
      .addNode("emit_b", async () => ({
        messages: [new AIMessage("hi there")],
      }))
      .addEdge("__start__", "emit_a")
      .addEdge("emit_a", "emit_b")
      .compile();
    const result = await graph.invoke({ task: "x" });
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].content).toBe("hello");
    expect(result.messages[1].content).toBe("hi there");
  });

  it("messages defaults to []", async () => {
    const State = darwinMessagesAnnotation();
    const graph = new StateGraph(State)
      .addNode("noop", async () => ({ output: "" }))
      .addEdge("__start__", "noop")
      .compile();
    const result = await graph.invoke({ task: "x" });
    expect(result.messages).toEqual([]);
  });

  it("task / output / darwinTrajectory channels still work (Darwin defaults)", async () => {
    const State = darwinMessagesAnnotation();
    const graph = new StateGraph(State)
      .addNode("noop", async (state) => ({
        output: `got: ${state.task}`,
      }))
      .addEdge("__start__", "noop")
      .compile();
    const result = await graph.invoke({ task: "ping" });
    expect(result.task).toBe("ping");
    expect(result.output).toBe("got: ping");
    expect(result.darwinTrajectory).toBeUndefined();
  });

  it("composes with extra channels", async () => {
    const { Annotation } = await import("@langchain/langgraph");
    const State = darwinMessagesAnnotation({
      label: Annotation<string>(),
    });
    const graph = new StateGraph(State)
      .addNode("setlabel", async () => ({ label: "x" }))
      .addEdge("__start__", "setlabel")
      .compile();
    const result = await graph.invoke({ task: "t", label: "init" });
    expect(result.label).toBe("x");
    expect(result.messages).toEqual([]);
  });
});
