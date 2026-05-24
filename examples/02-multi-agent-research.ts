/**
 * Example 2 — Multi-agent research pipeline.
 *
 * Three Darwin agents wired into a StateGraph as researcher → critic →
 * writer. Each node consumes the previous node's output as its task,
 * captures its own trajectory under a distinct state key, and ships the
 * trajectories to a single evolution hook via `withDarwinEvolution`.
 *
 * Pattern matches `mcp-factory-langgraph.ts` Architect→Builder→Reviewer
 * flow (see `agents/mcp-factory-langgraph.ts` in nex-hq) — except this
 * version runs in-process and uses the Darwin runtime directly.
 *
 * Run with:
 *   npm install darwin-langgraph@alpha @langchain/langgraph darwin-agents@alpha
 *   npx tsx examples/02-multi-agent-research.ts
 *
 * NOTE on taskKey routing (R1 Analyst Finding 4, S1185): each downstream
 * node reads its predecessor's output as its task by setting
 * `taskKey: "<previousOutputKey>"`. Avoid shadowing the base "task"
 * channel if an even later node still needs the original task — pick a
 * distinct key (e.g. "originalTask") if you need both available.
 */

import { Annotation, StateGraph } from "@langchain/langgraph";
import { defineAgent } from "darwin-agents";

import {
  createDarwinNode,
  darwinAnnotation,
  withDarwinEvolution,
  type ExecutionTrace,
} from "../src/index.js";

async function main(): Promise<void> {
  const researcher = defineAgent({
    name: "researcher",
    role: "Topic Researcher",
    description: "Researches a topic, returns 5 facts with sources.",
    systemPrompt:
      "You are a topic researcher. Return exactly 5 facts, each on its own " +
      "line, with a source URL in parentheses at the end of the line.",
  });

  const critic = defineAgent({
    name: "critic",
    role: "Fact Critic",
    description: "Critiques the researcher's facts and flags weak claims.",
    systemPrompt:
      "You are a fact critic. The user gives you 5 facts. Return EITHER " +
      "'LGTM' if all 5 are well-sourced, or a numbered list of which " +
      "claims need stronger sourcing and why.",
  });

  const writer = defineAgent({
    name: "writer",
    role: "Synthesis Writer",
    description: "Writes a 100-word summary from researcher + critic outputs.",
    systemPrompt:
      "You receive a critique. Write a 100-word neutral summary using ONLY " +
      "the claims the critic did not flag.",
  });

  const State = darwinAnnotation({
    research: Annotation<string>(),
    critique: Annotation<string>(),
    summary: Annotation<string>(),
    researchTrace: Annotation<ExecutionTrace | undefined>(),
    critiqueTrace: Annotation<ExecutionTrace | undefined>(),
    summaryTrace: Annotation<ExecutionTrace | undefined>(),
  });

  const graph = withDarwinEvolution(
    new StateGraph(State)
      .addNode(
        "research",
        createDarwinNode(researcher, {
          outputKey: "research",
          trajectoryKey: "researchTrace",
        }),
      )
      .addNode(
        "critique",
        createDarwinNode(critic, {
          taskKey: "research",
          outputKey: "critique",
          trajectoryKey: "critiqueTrace",
        }),
      )
      .addNode(
        "write",
        createDarwinNode(writer, {
          taskKey: "critique",
          outputKey: "summary",
          trajectoryKey: "summaryTrace",
        }),
      )
      .addEdge("__start__", "research")
      .addEdge("research", "critique")
      .addEdge("critique", "write")
      .compile(),
    {
      nodeMap: {
        research: { agentName: "researcher", trajectoryKey: "researchTrace" },
        critique: { agentName: "critic", trajectoryKey: "critiqueTrace" },
        write: { agentName: "writer", trajectoryKey: "summaryTrace" },
      },
      onTrajectory: (event) => {
        console.log(
          `[evolution-hook] ${event.nodeName} (${event.agentName}): ` +
            `${event.trajectory.turnCount} turns, ` +
            `${event.trajectory.toolCalls.length} tool calls, ` +
            `${event.trajectory.mcpInvocations} MCP invocations`,
        );
      },
    },
  );

  const result = await graph.invoke({
    task: "What is the GEPA paper from Stanford 2024?",
  });

  console.log();
  console.log("=== Research ===");
  console.log(result.research);
  console.log();
  console.log("=== Critique ===");
  console.log(result.critique);
  console.log();
  console.log("=== Summary ===");
  console.log(result.summary);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
