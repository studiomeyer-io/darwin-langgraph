/**
 * Example 1 — Basic single-Darwin-node StateGraph.
 *
 * Runs ONE Darwin agent inside a LangGraph. The agent answers a single
 * task and writes its output back to graph state. Trajectory is captured
 * automatically and stored in `state.darwinTrajectory`.
 *
 * Run with:
 *   npm install darwin-langgraph@alpha @langchain/langgraph darwin-agents@alpha
 *   npx tsx examples/01-basic-node.ts
 *
 * Required env (for real LLM call):
 *   DARWIN_PROVIDER=ollama|claude-cli|openai|anthropic
 *   (plus provider-specific keys — see darwin-agents README)
 */

import { StateGraph } from "@langchain/langgraph";
import { defineAgent } from "darwin-agents";

import { createDarwinNode, darwinAnnotation } from "../src/index.js";

async function main(): Promise<void> {
  const summarizer = defineAgent({
    name: "summarizer",
    role: "Text Summarizer",
    description: "Summarizes any text into exactly 3 bullets.",
    systemPrompt:
      "You are a summarizer. Return EXACTLY 3 bullet points. No prose around them.",
    maxTurns: 2,
  });

  const State = darwinAnnotation();

  const graph = new StateGraph(State)
    .addNode("summarize", createDarwinNode(summarizer))
    .addEdge("__start__", "summarize")
    .compile();

  const result = await graph.invoke({
    task:
      "GEPA (Genetic-Pareto) is a 2024 paper from Stanford that proposes " +
      "evolving LLM prompts using a Pareto-front of N=3-5 variants with " +
      "text-feedback critics instead of scalar reward. Compare to RLAIF.",
  });

  console.log("=== Summary ===");
  console.log(result.output);
  console.log();
  console.log("=== Trajectory ===");
  console.log("  turns:", result.darwinTrajectory?.turnCount);
  console.log("  tools:", result.darwinTrajectory?.toolCalls?.length);
  console.log("  mcp invocations:", result.darwinTrajectory?.mcpInvocations);
  console.log("  text blocks:", result.darwinTrajectory?.textBlockCount);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
